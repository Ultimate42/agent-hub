// Room page helpers (served as /assets/room-ui.js): Markdown rendering, @mention autocomplete,
// voice recording. Kept out of the inline page script to avoid template-literal escaping.

(function () {
  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  }

  // ---------------------------------------------------------------------------
  // Markdown (safe subset): the text is HTML-escaped first, then a few tags are added.
  // Supports ``` code blocks ```, `code`, **bold**, *italic*, _italic_, ~~strike~~,
  // [links](https://...), bare URLs, # headings, > quotes, - / 1. lists.
  // ---------------------------------------------------------------------------
  const PH = '\u0000';

  function inline(text, slots) {
    const keep = (html) => { slots.push(html); return PH + (slots.length - 1) + PH; };
    return text
      .replace(/`([^`\n]+)`/g, (_, code) => keep('<code>' + code + '</code>'))
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) =>
        keep('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'))
      .replace(/https?:\/\/(?:(?!&quot;|&#x27;|&lt;|&gt;)[^\s<])+/g, (match) => {
        const url = match.replace(/[.,;:!?)\]]+$/, '');
        return keep('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>') +
          match.slice(url.length);
      })
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  }

  function renderMarkdown(src) {
    const slots = [];
    const keep = (html) => { slots.push(html); return PH + (slots.length - 1) + PH; };
    let text = String(src || '').replace(/\u0000/g, '');

    // Fenced code blocks first (their content is never formatted)
    text = text.replace(/```[\w+-]*[ \t]*\n?([\s\S]*?)```/g, (match, code, offset, whole) => {
      const before = offset > 0 && whole[offset - 1] !== '\n' ? '\n' : '';
      const nextChar = whole[offset + match.length];
      const after = nextChar !== undefined && nextChar !== '\n' ? '\n' : '';
      return before + keep('<pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>') + after;
    });
    text = esc(text);

    const out = [];
    let list = null; // 'ul' | 'ol'
    const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };

    for (const line of text.split('\n')) {
      let m;
      if (new RegExp('^' + PH + '\\d+' + PH + '$').test(line.trim())) {
        closeList();
        out.push(line.trim());
      } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        closeList();
        out.push('<div class="md-h md-h' + m[1].length + '">' + inline(m[2], slots) + '</div>');
      } else if ((m = line.match(/^&gt;\s?(.*)$/))) {
        closeList();
        out.push('<blockquote>' + inline(m[1], slots) + '</blockquote>');
      } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        const kind = /^\s*\d/.test(line) ? 'ol' : 'ul';
        if (list !== kind) { closeList(); out.push('<' + kind + '>'); list = kind; }
        out.push('<li>' + inline(m[1], slots) + '</li>');
      } else if (!line.trim()) {
        closeList();
        out.push('<br>');
      } else {
        closeList();
        out.push(inline(line, slots) + '<br>');
      }
    }
    closeList();

    let html = out.join('').replace(/(<br>)+$/, '');
    const restore = new RegExp(PH + '(\\d+)' + PH, 'g');
    // Slots can contain other slots (link inside a heading...): restore until stable
    for (let i = 0; i < 3 && restore.test(html); i++) {
      html = html.replace(restore, (_, n) => slots[Number(n)]);
    }
    return html;
  }

  // ---------------------------------------------------------------------------
  // @mention autocomplete on a textarea
  // ---------------------------------------------------------------------------
  function attachMentionAutocomplete(input, getNames) {
    const menu = document.createElement('div');
    menu.className = 'mention-menu';
    menu.style.display = 'none';
    input.parentNode.style.position = 'relative';
    input.parentNode.appendChild(menu);
    let items = [];
    let active = 0;
    let start = -1;

    function close() { menu.style.display = 'none'; items = []; }

    function render() {
      menu.innerHTML = items.map((n, i) =>
        '<div class="mention-item' + (i === active ? ' active' : '') + '" data-i="' + i + '">@' + esc(n) + '</div>'
      ).join('');
      menu.style.display = items.length ? 'block' : 'none';
    }

    function pick(i) {
      const name = items[i];
      if (name === undefined) return;
      const caret = input.selectionStart;
      const before = input.value.slice(0, start) + '@' + name + ' ';
      input.value = before + input.value.slice(caret);
      input.selectionStart = input.selectionEnd = before.length;
      close();
      input.focus();
    }

    input.addEventListener('input', () => {
      const upto = input.value.slice(0, input.selectionStart);
      const m = upto.match(/(^|\s)@([^\s@]*)$/);
      if (!m) return close();
      start = upto.length - m[2].length - 1;
      const q = m[2].toLowerCase();
      items = getNames().filter(n => n.toLowerCase().startsWith(q)).slice(0, 8);
      active = 0;
      render();
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    menu.addEventListener('mousedown', (e) => {
      const el = e.target.closest('.mention-item');
      if (el) { e.preventDefault(); pick(Number(el.dataset.i)); }
    });

    // Returns true when the key was used by the menu (caller must not send the message)
    return function handleKey(e) {
      if (!items.length || menu.style.display === 'none') return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        render();
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        pick(active);
      } else if (e.key === 'Escape') {
        close();
      } else {
        return false;
      }
      e.preventDefault();
      return true;
    };
  }

  // ---------------------------------------------------------------------------
  // Voice recording (MediaRecorder; needs HTTPS or localhost)
  // ---------------------------------------------------------------------------
  let recorder = null;

  async function toggleRecording(btn, onFile) {
    if (recorder) { recorder.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      alert('Voice recording is not available in this browser (HTTPS required).');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      alert('Microphone access denied: ' + err.message);
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find(t => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks = [];
    const startedAt = Date.now();
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(timer);
      recorder = null;
      btn.classList.remove('recording');
      btn.innerHTML = '&#127908;';
      const mime = (rec.mimeType || 'audio/webm').split(';')[0];
      const ext = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' }[mime] || 'webm';
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      if (chunks.length) onFile(new File(chunks, 'voice-' + stamp + '.' + ext, { type: mime }));
    };
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      btn.textContent = '⏹ ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }, 500);
    recorder = rec;
    rec.start();
    btn.classList.add('recording');
    btn.textContent = '⏹ 0:00';
  }

  window.RoomUI = { renderMarkdown, attachMentionAutocomplete, toggleRecording };
})();
