/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // 品牌与语义色（来自设计规范 §3）
        brand: {
          DEFAULT: '#2457D6', // 主色
          hover: '#1F49B8', // 主色 hover
          dark: '#16305C', // 深蓝（Hero/页脚）
        },
        accent: {
          cyan: '#4BB6D8', // 青色辅助
          orange: '#FF9E57', // 橙色强调
        },
        ink: {
          DEFAULT: '#18243A', // 深色标题
          body: '#3A465C', // 正文偏深
          muted: '#718096', // 辅助文本
        },
        surface: {
          page: '#F5F7FB', // 页面背景
          card: '#FFFFFF', // 卡片背景
          border: '#E6EAF0', // 边框
          hover: '#F8FAFE', // 卡片 hover
        },
        state: {
          success: '#18A957',
          warn: '#E8A317',
          danger: '#E0533D',
          info: '#2457D6',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'PingFang SC',
          'Microsoft YaHei',
          'Segoe UI',
          'sans-serif',
        ],
      },
      borderRadius: {
        card: '16px',
        btn: '8px',
      },
      boxShadow: {
        card: '0 6px 24px rgba(24, 36, 58, 0.06)',
        'card-hover': '0 10px 32px rgba(24, 36, 58, 0.10)',
        header: '0 1px 0 rgba(24, 36, 58, 0.06)',
        'header-scrolled': '0 4px 16px rgba(24, 36, 58, 0.08)',
        modal: '0 20px 60px rgba(24, 36, 58, 0.20)',
        popover: '0 8px 24px rgba(24, 36, 58, 0.12)',
      },
      maxWidth: {
        container: '1320px',
      },
      fontSize: {
        hero: ['40px', { lineHeight: '1.2', fontWeight: '700' }],
        'module-title': ['22px', { lineHeight: '1.3', fontWeight: '600' }],
        'card-title': ['18px', { lineHeight: '1.4', fontWeight: '600' }],
      },
      animation: {
        'fade-in': 'fadeIn 200ms ease-out',
        'slide-up': 'slideUp 240ms cubic-bezier(0.22, 1, 0.36, 1)',
        'slide-down': 'slideDown 240ms cubic-bezier(0.22, 1, 0.36, 1)',
        'scale-in': 'scaleIn 200ms cubic-bezier(0.22, 1, 0.36, 1)',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
    },
  },
  plugins: [],
};
