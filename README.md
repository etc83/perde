# <img width="64" height="64" alt="theatre-curtains" src="https://github.com/user-attachments/assets/6b944a07-c13d-4d94-8ab7-8e967382a5a8" />
# Perde 


macOS'ta yerel çalışan film/dizi arayüzü. Kaynaklar Torrentio + AllDebrid.

## Kurulum
1. `brew install node ffmpeg`
2. Bu klasörde `npm install` (hls.js'i yerel kurar; yapmazsanız CDN'den yüklenir)
3. `node server.js`, sonra http://localhost:7777
4. Ayarlar'a Torrentio manifest adresinizi yapıştırın, "Eklentiyi sına"ya basın.

## Kullanım
- **Afişe tıklayın:** o içerik için en son kullandığınız kaynak (sürüm adı + kalite) yeniden bulunur ve kaldığınız yerden oynatılır. Dizide yarım kalan bölüm, bittiyse sıradaki bölüm açılır. İçerik için henüz kaynak seçmediyseniz ya da önceki kaynak listede artık yoksa detay menüsü açılır. Kaynağı olan afişlerin üzerinde ▶ görünür.
- **Başlığa tıklayın:** detay menüsü (özet, oyuncular, bölümler, kaynak listesi) açılır; başka bir kaynak buradan seçilir.
- **Telefonda** sekmeler, kullanıcı adı ve çıkış ☰ menüsünün içindedir; arama kutusu açıkta kalır.

## Oynatma nasıl çalışır
- **MP4 / M4V / MOV** ("Doğrudan" etiketi): tarayıcının kendi oynatıcısı, doğrudan bağlantı. Sunucu devrede değil, HDR/4K donanımla çözülür.
- **MKV vb.** ("Yeniden paketlenir"): sunucuda `ffmpeg -c copy` ile görüntü kopyalanıp parça parça HLS'e paketlenir. Bekleme birkaç saniyedir. Yalnızca ses AAC'ye çevrilir.
  Sarma çubuğu uygulamaya aittir ve filmin tam süresini gösterir. Hazır olmayan bir noktaya sarılınca sunucu o noktadan yeni oturum başlatır (1-2 sn).
  Sunucu oturumu en yakın önceki anahtar kareden başlatır; oynatıcı, istediğiniz noktaya otomatik olarak atlar (ses/görüntü hizalı).
- Paketleme izleme noktasının en fazla `AHEAD_MIN` (varsayılan 10) dakika ilerisine kadar yapılır, sonra beklenir. Geçici dosyalar oynatıcı kapanınca silinir.
- Sunucu terminalinde her sarmada `[hls] ...` satırı çıkar (bağlantı çözümleme, ffprobe, ffmpeg süreleri); yavaşlık varsa nerede olduğunu gösterir.
- Yavaşlığı ölçmek için `PERDE_DEBUG=1 node server.js`: dosyanın bit hızı, bağlantı hızınız (MB/s) ve ffmpeg'in adım adım süreleri yazılır.
- Oynatıcı takılıyorsa: `PERDE_DEBUG=1 node server.js` ile başlatın; terminalde `[tarayıcı]` (duraklama, bekleme, hata olayları ve tampon durumu) ve `[sunucu]` (parça istekleri) satırları çıkar; videoyu kimin duraklattığını da gösterir (`pause() ÇAĞRILDI` = sayfadaki bir kod, yoksa tarayıcı/sistem). `http://localhost:7777/?engine=hls` adresi Safari'nin kendi HLS oynatıcısı yerine hls.js kullanır.
- **Ön tampon:** Safari oynatma listesini ilk indirdiğinde içinde yalnızca birkaç parça olursa, sonraki parçaları ancak ~10 saniye sonra görüyor ve video takılıyor. Bu yüzden sunucu ilk parçadan sonra en çok 3 sn bekleyip listede en az 3 parça olmasını sağlar (hızlı ağda ~1 sn, yavaş ağda 3 sn gecikme). Ayar: `PREROLL_SEGS=3` (0 = kapalı), `PREROLL_WAIT_MS=3000`.
- `EXT_START=1` (deneysel, varsayılan kapalı): listeye başlangıç noktası etiketi ekler. Safari'de videoyu dondurduğu görüldü, kullanmayın.
- `PREROLL=20` (saniye cinsinden hazırlama) önerilmez; başlangıcı uzatıyor.
- Oynatmazsa: "Uyumluluk modu" düğmesi, IINA veya VLC.

## Ses ve altyazı
- **Ses:** Dosyada birden fazla ses varsa "Ses" menüsü çıkar (Türkçe varsa otomatik seçilir). Değiştirince aynı yerden devam eder.
- **Gömülü altyazı:** Metin tabanlı olanlar (SubRip, ASS, WebVTT, mov_text) listelenir. Seçince izlediğiniz noktadan başlayan pencereler (önce 3, sonra 10 dakikalık) videodan çıkarılır; böylece altyazı birkaç saniyede gelir ve izledikçe ilerisi hazırlanır. Başka bir yere sarınca o bölge için kısa bir bekleme olur. Resim tabanlı (PGS/DVD) altyazılar desteklenmez.
- **OpenSubtitles:** Ayarlar'a API anahtarı, kullanıcı adı ve parola girin; IMDb numarasına göre otomatik aranır, listeden seçilir. Eski Türkçe (Windows-1254) altyazıların karakterleri düzeltilir.
- **Hatırlama:** Seçtiğiniz altyazı (dil, tür ve gecikme ayarı) o içerik için saklanır; dizide tüm bölümlerde geçerlidir. Sonraki açılışta aynı dildeki altyazı otomatik seçilir (gömülü yoksa OpenSubtitles'tan, tersi de geçerli). "Kapalı" seçerseniz kapalı kalır.
- Altyazı kayık görünürse "−0,5 sn / +0,5 sn" düğmeleriyle ayarlayın.
- Klavye: Boşluk oynat/duraklat, ←/→ 10 sn, F tam ekran, M sessiz, Esc kapat.

## Kullanıcılar ve erişim
- **İlk kurulum:** Sunucuyu başlatın, **sunucunun çalıştığı bilgisayarda** `http://localhost:7777` adresini açın ve yönetici hesabını oluşturun. (İlk kurulum başka cihazlardan yapılamaz.)
- **Giriş:** Herkes (yönetici dahil) kullanıcı adı ve parolayla girer; oturum 30 gün hatırlanır. 5 yanlış denemeden sonra 15 dakika kilitlenir.
- **Yönetici:** "Kullanıcılar" sekmesinden kullanıcı ekler, parola belirler, yönetici yapar ya da siler. "Hesabım" sayfasında sunucu ayarlarını (Torrentio adresi, OpenSubtitles) yönetir; bunları kullanıcılar göremez.
- **Ayrı veri:** Her kullanıcının kütüphanesi ve izleme ilerlemesi ayrıdır (`data/` klasörü). Eski `data.json` varsa ilk yöneticiye taşınır.
- **Kaynak adresleri tarayıcıya gitmez:** Torrentio adresi (AllDebrid anahtarınız içinde) ve kaynak bağlantıları yalnızca sunucuda kalır; kullanıcılar süreli bir bilet görür.
- `node server.js` (veya `npm start`) sunucuyu ağdaki cihazlara açar: yerel ağda `http://192.168.x.x:7777`, Tailscale'de `http://100.x.x.x:7777`. macOS ilk seferde "node gelen bağlantılara izin versin mi?" diye sorar: İzin ver.
- Güvenmediğiniz bir Wi-Fi'da (kafe, otel) yalnızca bu bilgisayara açmak için: `npm run local`.
- Evin dışından erişmek için Tailscale gibi özel bir ağ en güvenlisidir. Doğrudan internete açarsanız (HTTPS yok) parolalar şifresiz gider; bunu yapmayın ya da önüne HTTPS sağlayan bir tünel/proxy koyun.
- Yedek: `users.json` (hesaplar), `config.json` (ayarlar), `data/` (kullanıcı verisi) dosyalarını kopyalamanız yeterli.

## Veri
Hesaplar `users.json`, ayarlar `config.json`, kütüphane ve izleme ilerlemesi `data/` klasöründedir (kullanıcı başına bir dosya).
