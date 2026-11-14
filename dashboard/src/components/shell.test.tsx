import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Shell } from './shell';

describe('dashboard navigation permissions', () => {
  it('renders only navigation items granted by the authenticated principal', () => {
    const html = renderToStaticMarkup(createElement(Shell, {
      view: 'overview',
      setView: () => undefined,
      principal: { id: 'viewer-1', role: 'viewer' },
      permissions: ['status.read'],
      onLogout: () => undefined,
      children: createElement('div', null, 'page-content'),
    }));

    expect(html).toContain('运行总览');
    expect(html).toContain('机器人');
    expect(html).not.toContain('角色档案');
    expect(html).not.toContain('模型供应商');
    expect(html).not.toContain('插件管理');
    expect(html).not.toContain('配置发布');
  });

  it('keeps a viewer limited to status-only navigation', () => {
    const html = renderToStaticMarkup(createElement(Shell, {
      view: 'overview',
      setView: () => undefined,
      principal: { id: 'viewer-2', role: 'viewer' },
      permissions: ['status.read'],
      onLogout: () => undefined,
      children: 'overview',
    }));

    expect(html.match(/<button class="nav-item(?: nav-active)?"/g)?.length).toBe(3);
    expect(html).toContain('服务健康');
    expect(html).not.toContain('临时访问令牌');
    expect(html).not.toContain('运维审计');
  });
});
