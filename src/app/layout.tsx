import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'HME 分拣间',
  description: 'iCloud 隐藏邮件地址收件系统',
  // 这套后台不该出现在任何搜索结果里
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        {/*
          字体从 Google Fonts 取。Archivo 当标识牌式的展示字，
          Public Sans 做正文（公文式清晰，且不是人人都在用的 Inter），
          Martian Mono 专门服务地址标本 —— 它的分隔符字形区分度最高。
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Public+Sans:wght@400;500;600&family=Martian+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-floor text-ink antialiased">{children}</body>
    </html>
  );
}
