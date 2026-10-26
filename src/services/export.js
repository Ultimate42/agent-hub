import { database } from '../db.js';

/** All messages of a room, oldest first, decorated like API pages (attachments, reactions...). */
export function exportMessages(roomId) {
  const all = [];
  let before = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const page = database.getMessagesBefore(roomId, before, 500);
    if (page.length === 0) break;
    all.unshift(...page);
    before = page[0].id;
  }
  return all;
}

export function exportJson(room, messages) {
  return {
    room: { name: room.name, directive: room.directive, created_at: room.created_at },
    exported_at: new Date().toISOString(),
    messages
  };
}

export function exportMarkdown(room, messages) {
  const lines = [`# ${room.name}`, '', `Exported ${new Date().toISOString()} · ${messages.length} messages`, ''];
  if (room.directive) lines.push(`> **Directive:** ${room.directive.replace(/\n/g, '\n> ')}`, '');
  lines.push('---', '');
  for (const m of messages) {
    const meta = [
      `#${m.id}`,
      m.created_at,
      m.reply_to ? `↪ #${m.reply_to}` : null,
      m.type && m.type !== 'message' ? m.type : null,
      m.edited_at ? 'edited' : null
    ].filter(Boolean).join(' · ');
    lines.push(`**${m.author || 'system'}** · ${meta}`, '');
    if (m.deleted) lines.push('_(message deleted)_', '');
    else if (m.content) lines.push(m.content, '');
    for (const a of m.attachments || []) {
      lines.push(`📎 [${a.filename}](${a.url}) (${a.mime_type}, ${a.size} B)` + (a.transcript ? ` — “${a.transcript}”` : ''));
    }
    if (m.attachments?.length) lines.push('');
    if (m.reactions?.length) lines.push(m.reactions.map(r => `${r.emoji} ${r.count}`).join('  '), '');
  }
  return lines.join('\n');
}
