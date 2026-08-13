#!/usr/bin/env python3
"""Deterministic retrieval engine for the campus knowledge base (V1).

V1 deliberately avoids vector databases. Retrieval combines title match,
canonical-question match, keyword match and category match into a simple
relevance score, then filters out expired / unpublished / low-trust entries
before they can be returned as an authoritative answer.

Every command returns a single JSON object on stdout (errors are reported as
JSON with ``ok:false`` and exit code 1) so the campus agent and the web plugin
can consume the contract uniformly.

Required JSON schema (per knowledge entry):
    id, title, questions[], content, category, department, sourceName,
    sourceUrl, applicableGroups[], effectiveFrom, effectiveTo, updatedAt,
    status ("published"|"draft"), trustLevel, isDemo
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

WORKSPACE = Path(__file__).resolve().parents[3]
KNOWLEDGE_DIR = Path(
    os.environ.get("CAMPUS_KNOWLEDGE_DIR", WORKSPACE / "knowledge")
)
UNANSWERED_FILE = Path(
    os.environ.get(
        "CAMPUS_KNOWLEDGE_UNANSWERED_FILE",
        WORKSPACE / "data" / "knowledge-unanswered.json",
    )
)
CHINA_TZ = timezone(timedelta(hours=8))

# Relevance weights — tuned for a small deterministic corpus. Title and
# canonical-question matches dominate; keywords/category nudge ranking.
W_QUESTION = 10.0
W_TITLE = 6.0
W_KEYWORD = 2.0
W_CATEGORY = 1.5

# Answers below this threshold are treated as "not confident" so the agent
# should refuse to answer instead of presenting a weak match as official.
MIN_CONFIDENCE = 5.0

# Normalize Chinese text for matching: lowercase, strip punctuation/whitespace.
_NORMALIZE_RE = re.compile(r"[\s，。、！？,.!?;:：；\"'()（）\-—_/]+")
STOPWORDS = {
    "怎么", "如何", "怎么办", "怎么办呢", "请问", "一下", "哪里", "在哪儿",
    "什么", "是的", "吗", "呢", "啊", "吧", "我", "的", "了", "有", "和", "与",
}


class KnowledgeError(Exception):
    def __init__(self, code: str, message: str, details: Any | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


# --------------------------------------------------------------------------- #
# IO helpers
# --------------------------------------------------------------------------- #
def output(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def fail(error: KnowledgeError) -> int:
    payload: dict[str, Any] = {
        "ok": False,
        "error": {"code": error.code, "message": error.message},
    }
    if error.details is not None:
        payload["error"]["details"] = error.details
    output(payload)
    return 1


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise KnowledgeError("DATA_NOT_FOUND", f"找不到数据文件：{path}") from exc
    except json.JSONDecodeError as exc:
        raise KnowledgeError("INVALID_DATA", f"数据文件不是有效 JSON：{path}") from exc


def atomic_write(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


@contextmanager
def file_lock(path: Path, timeout: float = 5.0) -> Iterable[None]:
    import time

    lock_path = path.with_suffix(path.suffix + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+b")
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise KnowledgeError(
                        "DATA_BUSY", "知识库文件正忙，请稍后重试"
                    )
                time.sleep(0.05)
        yield
    finally:
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def now() -> datetime:
    override = os.environ.get("CAMPUS_KNOWLEDGE_NOW")
    if override:
        value = datetime.fromisoformat(override)
        return value if value.tzinfo else value.replace(tzinfo=CHINA_TZ)
    return datetime.now(CHINA_TZ)


# --------------------------------------------------------------------------- #
# Loading & validation
# --------------------------------------------------------------------------- #
REQUIRED_FIELDS = (
    "id",
    "title",
    "content",
    "category",
    "department",
    "sourceName",
    "applicableGroups",
    "effectiveFrom",
    "updatedAt",
    "status",
    "trustLevel",
    "isDemo",
)


def load_all_entries() -> list[dict[str, Any]]:
    """Load every *.json file under the knowledge root, flattened to a list."""
    if not KNOWLEDGE_DIR.exists():
        raise KnowledgeError(
            "KNOWLEDGE_DIR_MISSING",
            f"知识库目录不存在：{KNOWLEDGE_DIR}",
        )
    entries: list[dict[str, Any]] = []
    for path in sorted(KNOWLEDGE_DIR.rglob("*.json")):
        data = load_json(path)
        if isinstance(data, dict):
            # Allow a single-object file as a convenience.
            entries.append(data)
        elif isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    entries.append(item)
                else:
                    raise KnowledgeError(
                        "INVALID_DATA",
                        f"{path} 中存在非对象条目",
                    )
        else:
            raise KnowledgeError("INVALID_DATA", f"{path} 根节点必须是对象或数组")
    # De-duplicate by id, keeping first occurrence; flag duplicates.
    seen: dict[str, str] = {}
    deduped: list[dict[str, Any]] = []
    for entry in entries:
        entry_id = str(entry.get("id", "")).strip()
        if entry_id in seen:
            # Keep it but annotate so validate() can surface the issue.
            entry = dict(entry)
            entry["_duplicateOf"] = seen[entry_id]
        deduped.append(entry)
        if entry_id and entry_id not in seen:
            seen[entry_id] = entry_id
    return deduped


def validate_entry(entry: dict[str, Any], ref_time: datetime) -> list[str]:
    """Return human-readable problems for one entry (empty list = healthy)."""
    problems: list[str] = []
    for field in REQUIRED_FIELDS:
        if field not in entry:
            problems.append(f"缺少字段 {field}")
    if entry.get("_duplicateOf"):
        problems.append(f"编号与 {entry['_duplicateOf']} 重复")
    questions = entry.get("questions")
    if not isinstance(questions, list) or not questions:
        problems.append("缺少标准问题 questions")
    if not entry.get("sourceName"):
        problems.append("缺少来源名称 sourceName")
    effective_from = entry.get("effectiveFrom")
    if not effective_from:
        problems.append("缺少生效时间 effectiveFrom")
    if not entry.get("updatedAt"):
        problems.append("缺少更新时间 updatedAt")
    status = str(entry.get("status", "")).strip()
    if status not in {"published", "draft"}:
        problems.append("status 必须是 published 或 draft")
    expired = is_expired(entry, ref_time)
    if expired:
        problems.append("已过期（effectiveTo 早于当前时间）")
    if problems:
        return problems
    return []


# --------------------------------------------------------------------------- #
# Time / status helpers
# --------------------------------------------------------------------------- #
def parse_date(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(CHINA_TZ) if parsed.tzinfo else parsed.replace(tzinfo=CHINA_TZ)


def is_expired(entry: dict[str, Any], ref_time: datetime) -> bool:
    end = parse_date(entry.get("effectiveTo"))
    return end is not None and end < ref_time


def is_published(entry: dict[str, Any]) -> bool:
    return str(entry.get("status", "")).strip() == "published"


def is_answerable(entry: dict[str, Any], ref_time: datetime) -> bool:
    """An entry may be returned as an authoritative answer only when it is
    published, not expired, and not low-trust/unverified."""
    return (
        is_published(entry)
        and not is_expired(entry, ref_time)
        and str(entry.get("trustLevel", "")).strip() != "unverified"
    )


# --------------------------------------------------------------------------- #
# Matching / scoring
# --------------------------------------------------------------------------- #
def normalize(text: str) -> str:
    return _NORMALIZE_RE.sub("", (text or "").lower())


def tokenize(text: str) -> list[str]:
    cleaned = _NORMALIZE_RE.sub(" ", (text or "").lower())
    tokens = []
    for raw in cleaned.split():
        if raw in STOPWORDS or len(raw) < 1:
            continue
        tokens.append(raw)
    return tokens


def score_entry(entry: dict[str, Any], query_norm: str, query_tokens: list[str]) -> float:
    """Deterministic relevance score. Higher = more relevant."""
    score = 0.0
    matched_on: list[str] = []

    title_norm = normalize(str(entry.get("title", "")))
    if title_norm and query_norm:
        if query_norm == title_norm:
            score += W_TITLE
            matched_on.append("title:exact")
        elif query_norm in title_norm or title_norm in query_norm:
            score += W_TITLE * 0.8
            matched_on.append("title:substring")
        else:
            # Title term overlap.
            title_tokens = set(tokenize(str(entry.get("title", ""))))
            overlap = len(title_tokens & set(query_tokens))
            if overlap:
                score += min(W_TITLE, overlap * 1.5)
                matched_on.append(f"title:terms:{overlap}")

    best_question_score = 0.0
    for question in entry.get("questions", []) or []:
        q_norm = normalize(str(question))
        if not q_norm:
            continue
        if query_norm == q_norm:
            best_question_score = max(best_question_score, W_QUESTION)
            matched_on.append("question:exact")
        elif query_norm in q_norm or q_norm in query_norm:
            best_question_score = max(best_question_score, W_QUESTION * 0.85)
            matched_on.append("question:substring")
        else:
            q_tokens = set(tokenize(str(question)))
            overlap = len(q_tokens & set(query_tokens))
            if overlap:
                best_question_score = max(
                    best_question_score, min(W_QUESTION * 0.6, overlap * 1.2)
                )
                matched_on.append(f"question:terms:{overlap}")
    score += best_question_score

    keyword_tokens = set(tokenize(" ".join(str(k) for k in entry.get("keywords", []) or [])))
    kw_overlap = len(keyword_tokens & set(query_tokens))
    if kw_overlap:
        score += min(W_KEYWORD * 2, kw_overlap * W_KEYWORD)
        matched_on.append(f"keywords:{kw_overlap}")

    category_norm = normalize(str(entry.get("category", "")))
    if category_norm and (
        category_norm in query_norm
        or any(category_norm in tok for tok in query_tokens)
    ):
        score += W_CATEGORY
        matched_on.append("category")

    return round(score, 3), matched_on


def public_view(entry: dict[str, Any]) -> dict[str, Any]:
    """Project an entry to the fields the agent/web are allowed to show."""
    return {
        "id": entry.get("id"),
        "title": entry.get("title"),
        "content": entry.get("content"),
        "steps": entry.get("steps") or [],
        "category": entry.get("category"),
        "department": entry.get("department"),
        "sourceName": entry.get("sourceName"),
        "sourceUrl": entry.get("sourceUrl") or "",
        "applicableGroups": entry.get("applicableGroups") or [],
        "effectiveFrom": entry.get("effectiveFrom"),
        "effectiveTo": entry.get("effectiveTo"),
        "updatedAt": entry.get("updatedAt"),
        "status": entry.get("status"),
        "trustLevel": entry.get("trustLevel"),
        "isDemo": bool(entry.get("isDemo")),
    }


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #
def cmd_search(args: argparse.Namespace) -> dict[str, Any]:
    ref_time = now()
    entries = load_all_entries()
    query_norm = normalize(args.query)
    query_tokens = tokenize(args.query)
    if not query_norm:
        raise KnowledgeError("EMPTY_QUERY", "搜索内容不能为空")

    scored = []
    for entry in entries:
        score, matched_on = score_entry(entry, query_norm, query_tokens)
        if score <= 0:
            continue
        scored.append((score, matched_on, entry))
    scored.sort(key=lambda triple: triple[0], reverse=True)

    results = []
    for score, matched_on, entry in scored[: args.limit]:
        view = public_view(entry)
        view["score"] = score
        view["matchedOn"] = matched_on
        view["answerable"] = is_answerable(entry, ref_time)
        view["expired"] = is_expired(entry, ref_time)
        view["published"] = is_published(entry)
        results.append(view)

    top_score = results[0]["score"] if results else 0.0
    confident = top_score >= MIN_CONFIDENCE and any(
        r["answerable"] for r in results
    )
    return {
        "ok": True,
        "query": args.query,
        "totalMatches": len(scored),
        "returned": len(results),
        "confidence": round(top_score, 3),
        "confident": confident,
        "minConfidence": MIN_CONFIDENCE,
        "refTime": ref_time.isoformat(timespec="seconds"),
        "results": results,
    }


def cmd_get(args: argparse.Namespace) -> dict[str, Any]:
    ref_time = now()
    entries = load_all_entries()
    target = next((e for e in entries if str(e.get("id", "")).strip() == args.knowledge_id), None)
    if target is None:
        raise KnowledgeError("NOT_FOUND", f"没有找到编号为 {args.knowledge_id} 的知识")
    view = public_view(target)
    view["answerable"] = is_answerable(target, ref_time)
    view["expired"] = is_expired(target, ref_time)
    view["published"] = is_published(target)
    return {"ok": True, "entry": view}


def cmd_list(args: argparse.Namespace) -> dict[str, Any]:
    ref_time = now()
    entries = load_all_entries()
    category = (args.category or "").strip()
    show_all = args.include_unpublished
    items = []
    for entry in entries:
        if category and normalize(str(entry.get("category", ""))) != normalize(category):
            continue
        if not show_all and not is_published(entry):
            continue
        if not show_all and is_expired(entry, ref_time):
            continue
        items.append(public_view(entry))
    items.sort(key=lambda v: (v.get("category", ""), v.get("id", "")))
    return {
        "ok": True,
        "category": category or None,
        "includeUnpublished": show_all,
        "total": len(items),
        "entries": items,
    }


def cmd_validate(args: argparse.Namespace) -> dict[str, Any]:
    ref_time = now()
    entries = load_all_entries()
    healthy: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    for entry in entries:
        problems = validate_entry(entry, ref_time)
        if problems:
            issues.append(
                {
                    "id": entry.get("id"),
                    "title": entry.get("title"),
                    "problems": problems,
                }
            )
        else:
            healthy.append({"id": entry.get("id"), "title": entry.get("title")})
    return {
        "ok": True,
        "total": len(entries),
        "healthy": len(healthy),
        "withIssues": len(issues),
        "issues": issues,
    }


def cmd_record_unanswered(args: argparse.Namespace) -> dict[str, Any]:
    """Persist a question the KB could not answer, for later admin review.

    This never produces an answer — it only logs that an answer was missing.
    """
    question = " ".join((args.question or "").split())
    if not question or len(question) > 500:
        raise KnowledgeError("INVALID_QUESTION", "问题长度需要在 1 到 500 个字符之间")
    record = {
        "question": question,
        "recordedAt": now().isoformat(timespec="seconds"),
        "source": args.source or "campus-assistant",
    }
    with file_lock(UNANSWERED_FILE):
        existing = []
        if UNANSWERED_FILE.exists():
            try:
                loaded = json.loads(UNANSWERED_FILE.read_text(encoding="utf-8"))
                if isinstance(loaded, list):
                    existing = loaded
            except json.JSONDecodeError:
                existing = []
        existing.append(record)
        atomic_write(UNANSWERED_FILE, existing)
    return {"ok": True, "recorded": True, "total": len(existing)}


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="云川校园知识库 V1 确定性检索引擎")
    commands = parser.add_subparsers(dest="command", required=True)

    search = commands.add_parser("search", help="按学生问题检索知识")
    search.add_argument("--query", required=True)
    search.add_argument("--limit", type=int, default=5, choices=range(1, 21))
    search.set_defaults(handler=cmd_search)

    get = commands.add_parser("get", help="按编号读取单条知识")
    get.add_argument("--knowledge-id", required=True)
    get.set_defaults(handler=cmd_get)

    list_cmd = commands.add_parser("list", help="按分类浏览知识")
    list_cmd.add_argument("--category", default="")
    list_cmd.add_argument("--include-unpublished", action="store_true")
    list_cmd.set_defaults(handler=cmd_list)

    validate = commands.add_parser("validate", help="校验数据完整性与生效状态")
    validate.set_defaults(handler=cmd_validate)

    record = commands.add_parser("record-unanswered", help="记录无法回答的问题")
    record.add_argument("--question", required=True)
    record.add_argument("--source", default="")
    record.set_defaults(handler=cmd_record_unanswered)

    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        output(args.handler(args))
        return 0
    except KnowledgeError as error:
        return fail(error)
    except Exception as error:  # Defensive boundary for the agent tool contract.
        return fail(
            KnowledgeError("INTERNAL_ERROR", "知识库检索失败", str(error))
        )


if __name__ == "__main__":
    sys.exit(main())
