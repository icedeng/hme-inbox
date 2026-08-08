import type { NextConfig } from 'next';

const config: NextConfig = {
  // standalone 产物只带被静态分析到的依赖，配合 Dockerfile 的多阶段构建
  output: 'standalone',

  // node:sqlite 与 mailparser 含原生/动态 require，交给 Node 运行时直接加载，
  // 不要让打包器去分析 —— 打包后 better-sqlite3 式的绑定路径会失效
  serverExternalPackages: ['mailparser', 'imapflow'],

  // 内网 compose 直接暴露 Next.js 端口时没有 Nginx/Caddy 重写层。
  // 兼容旧的取件链接格式：/{token}/{email} → /m/{token}/{email}。
  // afterFiles 早于动态路由匹配，必须显式排除应用自身的顶级路径。
  async rewrites() {
    return {
      afterFiles: [
        {
          source:
            '/:token((?!m/|admin/|api/|login/|_next/)[^/]+)/:email',
          destination: '/m/:token/:email',
        },
        {
          source:
            '/:token((?!m/|admin/|api/|login/|_next/)[^/]+)/:email/:messageId',
          destination: '/m/:token/:email/:messageId',
        },
      ],
    };
  },

  async headers() {
    return [
      {
        // 取件地址是能力 URL，被搜索引擎索引或缓存都是灾难性的
        source: '/m/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
      {
        source: '/admin/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
