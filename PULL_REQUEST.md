# PR: Netflix tarzı arayüz, kalıcı filtre menüsü ve IMDb puanı düzeltmeleri

**Head branch:** `feature/netflix-ui-filters` (mevcut çalışma dalı) → **Base:** `main`
Not: Bu ortamda uzak depo (git remote) yapılandırılmadığı için `git push`/`gh pr create` gerçekleştirilemedi. Aşağıdaki talimatlarla kendi makinenizde PR'ı tek komutla açabilirsiniz.

```bash
git remote add origin <repo-adresi>
git push -u origin feature/netflix-ui-filters
gh pr create --base main --head feature/netflix-ui-filters \
  --title "Netflix tarzı yatay gruplu liste, siyah tema ve kalıcı filtre menüsü" \
  --body-file PULL_REQUEST.md
```

## Özet
İçerik arama/keşfet/kütüphane deneyimi Netflix benzeri bir arayüze dönüştürüldü; filtre menüsü arama kutusundan bağımsız, kalıcı ve tüm bölümlerde etkili hale getirildi.

## Değişiklikler

### 1. Filtre menüsü (public/index.html)
- Arama dışı, her zaman erişilebilir filtre paneli: **Tür** (Fark etmez / Film / Dizi), **Yıl** (tek seçimli dropdown — sonuçlarda gerçekten bulunan yıllar), **IMDb puanı** (dropdown: Fark etmez, 1+ … 9+), **Sıralama** (İlgililik / Puan / Yenilik / A→Z).
- Seçim yapıldığında panel **kapanmaz**; alttaki içerikler anında filtrelenir, aktif filtre rozeti ve "x / y sonuç" sayacı güncellenir.
- Türkçe altyazı filtresi kaldırıldı (önceki istek doğrultusunda).
- Filtre tercihleri **localStorage + sunucu (users.json)** üzerinden kalıcı; Keşfet ve Kütüphanem listeleri de aynı filtrelere göre gösterilir.

### 2. IMDb puanı doğruluğu (server.js + client)
- Cinemeta katalog kayıtlarında eksik `imdbRating`/`year` alanları `/meta` tam meta çağrısıyla doldurulur (backfill; mevcut doğru değerler ezilmez).
- Puanı bilinemeyen içerikler için OpenSubtitles sorgusu (`POST /api/osmeta`) otomatik tetiklenir; yanıt gelince grid anında güncellenir.
- **Kural:** IMDb puanı eşiği seçiliyken puan bilgisi olmayan içerik gösterilmez.

### 3. Netflix tarzı düzen (public/index.html)
- İçerikler türe göre gruplanıp **yatay kaydırılabilir satırlar (rails)** halinde gösterilir (scroll-snap, gizle scrollbar, hover büyümesi). İlgililik sıralamasında uzun listeler 18'lik parçalara bölünüp çoklu satır olur.
- Keşfet kataloğu 3 sayfa (~600 öğe) çekilerek daha fazla içerik sunulur.
- Arama sonuç görünümü dikey grid olarak korunur.

### 4. Siyah tema ve afiş ayrımı
- Sabit koyu tema: `--bg:#000`, panel `#141414`, çizgi `#2e2e2e`, metin `#f3f3f3`; amber vurgu ve Netflix kırmızısı (`#e5050f`) ilerleme çubuğu. Giriş/kurulum sayfası da aynı palete uyarlandı (server.js LOGIN şablonu).
- Her afişte ince çerçeve (`1px rgba(255,255,255,.14)`) + yumuşak gölge (`0 4px 14px rgba(0,0,0,.55)`).

## Doğrulama
- `node --check server.js` ✅
- applyFilters / fetchOsMeta / rails birim testleri (Node) ✅ — örn. eşik 6 → düşük puanlı elenir; eşik 8 → yalnızca yüksek puanlı; yıl+tür kombinasyonları doğru.
- Yerel sunucu testi: `/login` yeni siyah temayla servis ediliyor, ana sayfa 302 ile girişe yönlendiriyor, `/api/osmeta` kimlik doğrulamasız istekleri reddediyor. ✅

## Diff özeti (main..HEAD)
```
 .gitignore        |   1 +
 package-lock.json | 506 ++++-
 package.json      |   5 +-
 public/index.html | 292 +++++++---
 server.js         |  55 ++-
 users.json        |  12 +
 6 files changed, 843 insertions(+), 28 deletions(-)
```
