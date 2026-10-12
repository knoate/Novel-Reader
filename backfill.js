const fs = require('fs');
let illus = [];
try { illus = JSON.parse(fs.readFileSync('data/illustrations.json', 'utf8')); } catch (e) {}
const existing = new Set(illus.map(i => i.image));
const chapters = JSON.parse(fs.readFileSync('data/chapters.json', 'utf8'));
let added = 0;
for (const ch of chapters) {
    const re = /!\[([^\]]*)\]\((\/images\/[^)]+)\)/g;
    let m;
    while ((m = re.exec(ch.content || '')) !== null) {
        if (!existing.has(m[2])) {
            illus.unshift({
                id: Math.random().toString(36).slice(2),
                chapterId: ch.id,
                scene: m[1] || '',
                prompt: '', anchor: '',
                engine: 'unknown', seed: null,
                image: m[2],
                createdAt: new Date().toISOString()
            });
            added++;
        }
    }
}
fs.writeFileSync('data/illustrations.json', JSON.stringify(illus, null, 2));
console.log('补录新增', added, '条，总计', illus.length, '条');
