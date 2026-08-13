// ============================================================
// 云川大学校园门户 - 全局类型定义
// ============================================================

/** 主导航项 */
export interface NavItem {
  key: string;
  label: string;
  href: string;
}

/** 当前登录用户 */
export interface CurrentUser {
  id: string;
  name: string; // 显示名，如「林同学」
  studentId: string; // 学号
  avatarColor: string; // 头像背景色（无图，纯色占位）
  initial: string; // 头像首字
  department: string; // 学院
}

/** 今日校园信息卡 */
export interface TodayCampus {
  dateText: string; // 如「9月16日 星期一」
  weatherText: string; // 如「23°C 多云」
  weatherIcon: WeatherKind;
  teachingWeek: string; // 如「第 3 教学周」
  semester: string; // 如「2026 秋季学期」
}

export type WeatherKind = 'sunny' | 'cloudy' | 'rainy' | 'snow';

/** 常用服务入口 */
export interface ServiceItem {
  key: string;
  label: string;
  icon: string; // Lucide 图标名
  color: 'brand' | 'orange' | 'cyan' | 'purple' | 'green' | 'pink';
  /** 点击行为：打开某个模态框、Toast 或外部跳转 */
  action:
    | { kind: 'open-leave' }
    | { kind: 'open-course' }
    | { kind: 'toast'; message: string }
    | { kind: 'link'; href: string };
}

/** 课程（今日课表 / 选课中心共用） */
export interface Course {
  id: string;
  name: string;
  teacher: string;
  startTime: string; // 「08:00」
  endTime: string; // 「09:40」
  location: string; // 「博学楼 A203」
  /** 选课中心字段 */
  credit?: number;
  capacity?: number;
  enrolled?: number;
  category?: string; // 「专业必修」等
  selected?: boolean; // 是否已选
}

/** 待办事项 */
export interface TodoItem {
  id: string;
  title: string;
  type: 'leave' | 'course' | 'library' | 'other';
  status: 'pending' | 'processing' | 'due-soon';
  statusText: string; // 「待审批」「待处理」「3天后到期」
  dueText?: string; // 「9月20日截止」
}

/** 校园通知 */
export interface Notice {
  id: string;
  title: string;
  category: string; // 「教务」「后勤」等
  date: string; // 「2026-09-15」
  unread?: boolean;
}

/** 校园活动 */
export interface Activity {
  id: string;
  title: string;
  cover: string; // 颜色渐变（无图，纯 CSS 渐变占位）
  coverLabel: string; // 渐变中心文字
  date: string;
  location: string;
  tag: string;
}

/** 消息提醒 */
export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  time: string;
  unread: boolean;
  kind: 'leave' | 'course' | 'notice' | 'system';
}

// ============================================================
// 请假申请表单
// ============================================================

export type LeaveType = 'sick' | 'personal' | 'official' | 'other';

export interface LeaveForm {
  type: LeaveType;
  startDate: string;
  endDate: string;
  reason: string;
  attachmentName: string | null;
}

export type LeaveFormError = Partial<Record<keyof LeaveForm, string>>;

// ============================================================
// Toast 反馈
// ============================================================

export type ToastVariant = 'success' | 'info' | 'warn' | 'error';

export interface ToastMessage {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  duration: number; // ms
}
