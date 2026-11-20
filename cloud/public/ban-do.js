// Sơ đồ phòng dạng chữ để admin/VLearn tự sửa, dùng chung cho trang admin và trang siêu admin.
//   # KHU 20 PHÒNG (DÃY TRƯỚC SẢNH)
//   Tầng 4 [PHÒNG ĐỢI]: 409 12 SINH; 408 12 HOÁ; |; 407 12 LÝ
// Mỗi ô cách nhau bằng dấu ;  –  ô đầu là số phòng, phần sau là tên lớp.  |  là cầu thang (ngắt dãy phòng sát vách).
window.BanDo = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function format(map) {
    return map.map(z => [`# ${z.title}`, ...z.floors.map(f => `Tầng ${f.n}${f.wait ? ` [${f.wait}]` : ''}: ` +
      f.rooms.map(r => r ? `${r[0]} ${r[1]}`.trim() : '|').join('; '))].join('\n')).join('\n\n');
  }
  function parse(text) {
    const map = [], seen = new Set();
    let zone = null;
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim(), at = `Dòng ${i + 1}: `;
      if (!line || line.startsWith('//')) continue;
      if (line.startsWith('#')) { zone = { title: line.slice(1).trim() || 'KHU', floors: [] }; map.push(zone); continue; }
      const m = line.match(/^tầng\s+([^\s:\[]+)\s*(?:\[([^\]]*)\])?\s*:(.*)$/iu);
      if (!m) throw new Error(at + 'cần bắt đầu bằng "# Tên khu" hoặc "Tầng 1: 101 10A; 102 10B"');
      if (!zone) { zone = { title: 'KHU', floors: [] }; map.push(zone); }
      const rooms = m[3].split(';').map(s => s.trim()).filter(Boolean).map(s => {
        if (s === '|') return null;
        const [, id, label] = s.match(/^(\S+)\s*(.*)$/);
        if (!/^[A-Za-z0-9-]{1,10}$/.test(id)) throw new Error(at + `số phòng "${id}" chỉ gồm chữ không dấu, số, dấu -`);
        if (seen.has(id)) throw new Error(at + `phòng ${id} bị lặp`);
        seen.add(id);
        return [id, label];
      });
      zone.floors.push({ n: m[1], ...(m[2] ? { wait: m[2].trim() } : {}), rooms });
    }
    if (!seen.size) throw new Error('Sơ đồ chưa có phòng nào');
    return map;
  }
  function html(map) {   // xem trước, chỉ đọc
    return map.map(z => `<h3>${esc(z.title)}</h3><div class="scroll"><table class="map"><tbody>${z.floors.map(f => `<tr>
      <td class="y">TẦNG<br>${esc(f.n)}</td>${f.wait ? `<td class="fix">${esc(f.wait)}</td>` : ''}
      ${f.rooms.map(r => r ? `<td><b>P.${esc(r[0])}</b><br>${esc(r[1])}</td>` : '<td class="y">CẦU<br>THANG</td>').join('')}</tr>`).join('')}</tbody></table></div>`).join('');
  }
  return { format, parse, html };
})();
