export interface AdminPageGuardDeps {
  requireSession: () => Promise<string | null>;
  redirect: (path: string) => never;
}

/**
 * 后台页面的独立鉴权边界。
 *
 * Layout 在客户端导航时可能被缓存，不能作为唯一的授权边界；每个读取
 * 管理数据的页面都应在查询数据库前调用这个守卫。
 */
export function createAdminPageGuard(
  deps: AdminPageGuardDeps,
): () => Promise<string> {
  return async () => {
    const sessionId = await deps.requireSession();
    if (!sessionId) return deps.redirect('/login');
    return sessionId;
  };
}
