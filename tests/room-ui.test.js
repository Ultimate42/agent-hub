import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import { countPendingUnreplied } from '../src/utils/members.js';

const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL('../src/public/room-ui.js', import.meta.url), 'utf8'), ctx);
const md = ctx.window.RoomUI.renderMarkdown;

describe('Room UI Markdown', () => {
  test('escapes HTML before formatting', () => {
    const html = md('<img src=x onerror=alert(1)> **b**');
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));
    assert.ok(html.includes('<strong>b</strong>'));
  });

  test('code blocks and inline code are not formatted', () => {
    const html = md('```js\nconst a = **x** <b>;\n```\nand `*y*`');
    assert.ok(html.includes('<pre><code>const a = **x** &lt;b&gt;;</code></pre>'));
    assert.ok(html.includes('<code>*y*</code>'));
  });

  test('links: only http(s), quotes cannot break the attribute', () => {
    assert.ok(md('[go](https://a.com/x?y=1&z=2)').includes('<a href="https://a.com/x?y=1&amp;z=2"'));
    assert.ok(!md('[x](javascript:alert(1))').includes('<a '));
    const bare = md('see "https://a.com/p" now.');
    assert.ok(bare.includes('<a href="https://a.com/p"'));
    assert.ok(!bare.includes('href="https://a.com/p&quot'));
  });

  test('lists, quotes, headings, italic, strike', () => {
    const html = md('# Title\n- one\n- two\n1. first\n> quoted\n*it* _it2_ ~~no~~ snake_case_name');
    assert.ok(html.includes('<div class="md-h md-h1">Title</div>'));
    assert.ok(html.includes('<ul><li>one</li><li>two</li></ul>'));
    assert.ok(html.includes('<ol><li>first</li></ol>'));
    assert.ok(html.includes('<blockquote>quoted</blockquote>'));
    assert.ok(html.includes('<em>it</em> <em>it2</em> <del>no</del> snake_case_name'));
  });
});

describe('countPendingUnreplied', () => {
  const members = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
  test('counts mentions and replies after the member last spoke', () => {
    const messages = [
      { id: 1, member_id: 1, author: 'Alice', content: 'hi', reply_to: null },
      { id: 2, member_id: 2, author: 'Bob', content: '@Alice question?', reply_to: null },
      { id: 3, member_id: 2, author: 'Bob', content: 'answer this', reply_to: 1 },
      { id: 4, member_id: null, author: 'system', content: '@Alice joined', reply_to: null }
    ];
    const c = countPendingUnreplied(messages, members);
    assert.strictEqual(c.get(1), 2);
    assert.strictEqual(c.get(2), 0);
    messages.push({ id: 5, member_id: 1, author: 'Alice', content: 'done', reply_to: null });
    assert.strictEqual(countPendingUnreplied(messages, members).get(1), 0);
  });
});
