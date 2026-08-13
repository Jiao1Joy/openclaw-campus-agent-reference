// ============================================================
// 云川大学校园门户 - 本地 Mock 数据
// 设计依据：design/campus-homepage-spec.md
// ============================================================

import type {
  Activity,
  Course,
  CurrentUser,
  NavItem,
  NotificationItem,
  Notice,
  ServiceItem,
  TodoItem,
  TodayCampus,
} from '@/types';

/** 顶部主导航 */
export const NAV_ITEMS: NavItem[] = [
  { key: 'home', label: '首页', href: '#home' },
  { key: 'news', label: '校园资讯', href: '#news' },
  { key: 'academic', label: '教务服务', href: '#academic' },
  { key: 'life', label: '学生生活', href: '#life' },
  { key: 'map', label: '校园地图', href: '#map' },
];

/** 当前用户 */
export const CURRENT_USER: CurrentUser = {
  id: 'u-demo-student-001',
  name: '林同学',
  studentId: '202400001',
  avatarColor: '#2457D6',
  initial: '林',
  department: '计算机与人工智能学院',
};

/** 今日校园 */
export const TODAY_CAMPUS: TodayCampus = {
  dateText: '9月16日 星期一',
  weatherText: '23°C 多云',
  weatherIcon: 'cloudy',
  teachingWeek: '第 3 教学周',
  semester: '2026 秋季学期',
};

/** 常用服务入口（设计规范 §2 - 8 个） */
export const SERVICE_ITEMS: ServiceItem[] = [
  {
    key: 'course',
    label: '选课中心',
    icon: 'BookOpen',
    color: 'brand',
    action: { kind: 'open-course' },
  },
  {
    key: 'leave',
    label: '请假申请',
    icon: 'FileText',
    color: 'orange',
    action: { kind: 'open-leave' },
  },
  { key: 'schedule', label: '我的课表', icon: 'CalendarDays', color: 'cyan', action: { kind: 'toast', message: '正在打开本周完整课表…' } },
  { key: 'score', label: '成绩查询', icon: 'GraduationCap', color: 'purple', action: { kind: 'toast', message: '本学期成绩尚未发布' } },
  { key: 'exam', label: '考试安排', icon: 'ClipboardCheck', color: 'brand', action: { kind: 'toast', message: '期中考试安排将于 10 月 8 日发布' } },
  { key: 'campus-card', label: '校园卡', icon: 'CreditCard', color: 'green', action: { kind: 'toast', message: '校园卡余额：￥86.50' } },
  { key: 'venue', label: '场馆预约', icon: 'Trophy', color: 'pink', action: { kind: 'toast', message: '体育馆羽毛球场地可预约' } },
  { key: 'more', label: '更多服务', icon: 'LayoutGrid', color: 'cyan', action: { kind: 'toast', message: '更多服务正在建设中' } },
];

/** 今日课表 */
export const TODAY_SCHEDULE: Course[] = [
  {
    id: 'c1',
    name: '高等数学',
    teacher: '王教授',
    startTime: '08:00',
    endTime: '09:40',
    location: '博学楼 A203',
  },
  {
    id: 'c2',
    name: '大学英语',
    teacher: '李老师',
    startTime: '10:10',
    endTime: '11:50',
    location: '明德楼 B106',
  },
  {
    id: 'c3',
    name: '数据结构',
    teacher: '陈教授',
    startTime: '14:00',
    endTime: '15:40',
    location: '信息楼 301',
  },
];

/** 待办事项 */
export const TODO_ITEMS: TodoItem[] = [
  {
    id: 't1',
    title: '请假申请待审批',
    type: 'leave',
    status: 'pending',
    statusText: '待审批',
    dueText: '辅导员已收到，等待审批',
  },
  {
    id: 't2',
    title: '选课确认',
    type: 'course',
    status: 'processing',
    statusText: '待处理',
    dueText: '请在 9月20日 前确认',
  },
  {
    id: 't3',
    title: '图书即将到期',
    type: 'library',
    status: 'due-soon',
    statusText: '3天后到期',
    dueText: '《算法导论》9月19日到期',
  },
];

/** 校园通知 */
export const NOTICES: Notice[] = [
  {
    id: 'n1',
    title: '关于 2026 年秋季学期选课的通知',
    category: '教务',
    date: '2026-09-15',
    unread: true,
  },
  {
    id: 'n2',
    title: '校园网络维护公告',
    category: '后勤',
    date: '2026-09-14',
  },
  {
    id: 'n3',
    title: '图书馆延长开放时间',
    category: '图书馆',
    date: '2026-09-13',
  },
];

/** 校园活动 */
export const ACTIVITIES: Activity[] = [
  {
    id: 'a1',
    title: '2026 秋季校园招聘双选会',
    cover: 'linear-gradient(135deg, #2457D6 0%, #16305C 100%)',
    coverLabel: '秋招双选会',
    date: '9月25日 周三 14:00',
    location: '大学生活动中心 · 一层大厅',
    tag: '就业',
  },
  {
    id: 'a2',
    title: '「云川之秋」文艺晚会',
    cover: 'linear-gradient(135deg, #FF9E57 0%, #E8742E 100%)',
    coverLabel: '文艺晚会',
    date: '9月28日 周六 19:00',
    location: '大礼堂',
    tag: '文艺',
  },
  {
    id: 'a3',
    title: '校际篮球联赛 · 云川主场',
    cover: 'linear-gradient(135deg, #4BB6D8 0%, #2E8AB0 100%)',
    coverLabel: '篮球联赛',
    date: '9月30日 周一 16:00',
    location: '体育馆 · 主场',
    tag: '体育',
  },
];

/** 通知中心消息（消息铃气泡展开） */
export const NOTIFICATIONS: NotificationItem[] = [
  {
    id: 'msg1',
    title: '请假申请进展',
    body: '你的请假申请已被辅导员查看，请耐心等待审批。',
    time: '10 分钟前',
    unread: true,
    kind: 'leave',
  },
  {
    id: 'msg2',
    title: '选课提醒',
    body: '选课确认截止日为 9月20日，请尽快完成确认。',
    time: '2 小时前',
    unread: true,
    kind: 'course',
  },
  {
    id: 'msg3',
    title: '校园通知',
    body: '2026 秋季学期选课通知已发布，请前往教务服务查看。',
    time: '昨天',
    unread: true,
    kind: 'notice',
  },
];

/** 选课中心课程数据 */
export const COURSE_CATALOG: Course[] = [
  {
    id: 'sel1',
    name: '机器学习导论',
    teacher: '周教授',
    startTime: '周二 08:00',
    endTime: '09:40',
    location: '信息楼 205',
    credit: 3,
    capacity: 80,
    enrolled: 76,
    category: '专业选修',
    selected: false,
  },
  {
    id: 'sel2',
    name: '计算机网络',
    teacher: '吴教授',
    startTime: '周三 10:10',
    endTime: '11:50',
    location: '博学楼 B301',
    credit: 3,
    capacity: 60,
    enrolled: 60,
    category: '专业必修',
    selected: true,
  },
  {
    id: 'sel3',
    name: '操作系统',
    teacher: '黄教授',
    startTime: '周四 14:00',
    endTime: '15:40',
    location: '信息楼 102',
    credit: 4,
    capacity: 70,
    enrolled: 45,
    category: '专业必修',
    selected: false,
  },
  {
    id: 'sel4',
    name: '现代书法鉴赏',
    teacher: '钱老师',
    startTime: '周五 16:00',
    endTime: '17:30',
    location: '文科楼 308',
    credit: 2,
    capacity: 40,
    enrolled: 28,
    category: '通识选修',
    selected: false,
  },
  {
    id: 'sel5',
    name: '数据库系统原理',
    teacher: '孙教授',
    startTime: '周一 14:00',
    endTime: '15:40',
    location: '信息楼 201',
    credit: 3,
    capacity: 65,
    enrolled: 62,
    category: '专业必修',
    selected: true,
  },
  {
    id: 'sel6',
    name: '篮球（基础班）',
    teacher: '李教练',
    startTime: '周三 16:00',
    endTime: '17:30',
    location: '体育馆 B 场',
    credit: 1,
    capacity: 30,
    enrolled: 18,
    category: '体育必修',
    selected: false,
  },
];
