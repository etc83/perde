# PR: TV/mobil — afiş tek dokunma hedefi + basılı tutma/sağ tık menüsü + metin seçme engelleme

**Head:** `feature/reapply-tv-touch-menu` → **Base:** `main`

PR #25'te merge edilen, PR #26 (revert) ile geri alınan özellikler bu PR'da eksikleri de tamamlanmış şekilde yeniden uygulanıyor.

## Değişiklikler (yalnızca public/index.html)
1. **Afiş tek dokunma hedefi (TV + mobil):** kısa dokunuş → kaldığın yerden oynat; basılı tutma (≈500 ms) → Kütüphane / Ayrıntılar / İlerlemeyi sıfırla menüsü. `pb`/`add`/`nm` ayrı butonları kaldırıldı (uzak kumanda için tek odak hedefi); masaüstünde eski ayrı hedefler korundu.
2. **Masaüstü sağ tık:** afiş üzerinde sağ tık kendi menümüzü açar, tarayıcı bağlam menüsü engellenir.
3. **Mobil metin seçme engelleme:** body genelinde `user-select:none` + `-webkit-touch-callout:none`; `selectstart`/`dragstart` önlenir; input/select/textarea'da seçim serbest.
4. **Menü odak kapsaması:** menü açıkken TV odağı yalnızca menüde kalır; dışarı dokunuş/ESC ile kapanır.

## Doğrulama
- `node --check server.js` ✅
- index.html inline script blokları parse testi ✅
- Canlı sunucu smoke testi (LOCAL=1): /login 200, / 302, /api/progress auth'suz 401 ✅
