/**
 * 生成管理员密码的 scrypt 哈希，填进 ADMIN_PASSWORD_HASH。
 * 明文密码绝不进环境变量 —— 它会出现在 docker inspect、进程列表和崩溃日志里。
 *
 * 用法：npm run hash-password -- '你的密码'
 */
import { hashPassword } from '../src/lib/auth/password.ts';

const password = process.argv[2];
if (!password) {
  console.error("用法：npm run hash-password -- '你的密码'");
  console.error('注意用单引号包裹，避免 shell 解释特殊字符。');
  process.exit(1);
}
if (password.length < 8) {
  console.error('密码至少 8 位。');
  process.exit(1);
}

console.log(hashPassword(password));
