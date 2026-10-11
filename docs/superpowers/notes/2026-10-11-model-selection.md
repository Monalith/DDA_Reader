# Sürücü modeli v2 — yöntem seçimi (Faz 2 sentezi)

Tarih: 2026-10-11. Girdi: `research/2026-10-11-r1..r4-*.md` (4 Opus raporu, ~100 kaynak).
Çıktı: `specs/2026-10-11-virtual-rider-design-v2.md`. Durum: **kullanıcı onayı bekliyor.**

## 0. Raporların ortak sonucu (tek cümle)

Fizik seviyesini yükseltme; **sürücüyü** değiştir. Dört rapor da aynı yere çıkıyor: motosiklet
QSS/OCP modelleri gerçek turlara ~%0,9 yaklaşıyor ve DDA Lab'ın +%0,8'i zaten o bantta (R4 §2).
Kalan hata geometriden (R1, R2 §4.2: referans çizgisinin ima ettiği 1,95 g MotoGP'nin bile
üstünde). Kazanılacak şey tur süresi değil, **fren olayı sayısı, geçiş şekli ve parametrelerin
anlamı**. Bu, kullanıcının üç kısıtıyla birebir örtüşüyor.

## 1. Kararlar

| # | Katman | Seçim | Reddedilenler ve neden | Kaynak |
|---|---|---|---|---|
| K1 | **Araç** | Nokta-kütle QSS **+ cebirsel yük transferi** (gerçek CG konumu `b`, `h`; stoppie ve wheelie limitleri; lean'de `h_φ = t + (h−t)cosφ`) **+ crown/hang-off yatış düzeltmesi** (`tyreCrownM`, `hangOffM`) | Sharp 1971+/FastBike/OCP: parametreler telemetriden gözlenemez, tarayıcı bütçesini aşar, asıl hatayı (geometri) çözmez. Stabilite modları tur süresini etkilemez | R1 §2, §3.1-3.2, §5 |
| K2 | **Lastik** | Sürtünme elipsi **kalır**; yarı eksenler `μ_eff = μ_peak · g(s)` ile ölçeklenir, `g(s) = sin(C·atan(tan(π/2C)·s))`, **Cx = 1,6 (fren/çekiş), Cy = 1,3 (yanal)**; üç ayrı `s` (ön fren, arka çekiş, yanal) sürücü parametresi; `μx` ve `μy` ayrı alanlar, varsayılan eşit | Tam Magic Formula (40+ parametre, gözlenemez); termal/basınç (QSS araçları tek ölçek kullanır); relaxation length (~10 ms). R3'ün `sin(πρ/2)` şekli reddedildi: R2'nin eğrisi SEL-2004 ölçülmüş katsayılarından türetilmiş, R3'ünki keyfi | R2 §3.4-3.5, §5 |
| K3 | **3B yol** | g-bütçesi denklemleri (`g̃`, `ã_x`, `ã_y`, Lovato & Massaro 2022) çözücüye girer; `slopeRad[]`, `bankRad[]`, `nu[]` kanalları **varsayılan 0**; sıfır veride bit-bit aynı sonuç (test) | DEM'den eğim **ertelendi**: Serres toplam rölyef ~8 m, 50 m eğim ±2,8 % = DEM gürültüsü; beklenen etki ≤ 0,2-0,3 s, işareti belirsiz; kaba DEM düz modelden kötü olabilir (Biniewicz & Pyrz). Banking açık DEM'den çıkmaz | R1 §3.5-3.6, §4 |
| K4 | **Çizgi** | Mevcut κ-çizgisi (min-eğrilik/min-mesafe karışımı) **kalır** | Free-trajectory QSS (10× yavaş, ideal sürücü); min-time OCP | R4 §2, §5 adım 1 |
| K5 | **Boylamsal çözücü + sürücü** | **Viraj-olay modeli (R4 "S2")**: `corners.ts` segmentasyon → viraj başına 5 olay (B fren, T turn-in, A apex, P gaz, E çıkış) → olay şablonundan hız profili (jerk-sınırlı fren build, plato, lean'e bağlı trail release, bakım gazı penceresi, roll-on) → `v = min(olay, QSS zarfı)`. Mevcut 3-geçiş **üst sınır** olarak kalır, FBGA portu gerekmez | S1+ (olay birleştirme yaması): kısıt 2-3'ü sağlamaz, roll-rate tur süresine girmez. Tam OCP: dakikalar. FBGA portu: mevcut geçişler zaten forward-backward, zarf konveks | R3 §3, §7; R4 §5-6 |
| K6 | **Roll-rate** | Ek O(n) kısıt: `v ≤ φ̇_max / |dφ/ds|`, 2-3 sabit-nokta iterasyonu; `φ̇_max(V,φ) = A_kesri · (β0+β1·V)/g · cos²φ` (Biniewicz j_y) | Zaman-alanı roll DOF (kontrolcü gerekir) | R1 §3.3, R3 §4.3 |
| K7 | **Üst-parametreler** | `aggressiveness A ∈ [0,1]` → roll-rate kesri, fren build jerk'i, gaz pick-up gecikmesi, roll-on süresi. `risk R ∈ [0,1]` → `s_brake`, `s_drive`, `s_lat` (→ fren g, lean kullanımı, trail-brake derinliği). Mevcut `brakingG`, `leanUsage`, `trailBrake*`, `throttleDelayS`, `brakeRiseGps` **türetilen** değerler olur; gelişmiş panelde override | R3'ün "bölge-bölge fren varyasyonu" sezgiseli reddedildi: K1'in stoppie+drag tavanı hıza bağlı tepe frenini (K1'de −1,42 g, yavaş virajlarda −0,7…−1,1 g) fizikten üretir, sezgisele gerek yok | R3 §5, R1 §3.1, R2 §3.5 |
| K8 | **Gecikme sabitleri** | `BRAKE_ON` 0,14 s → ölçülen **0,37-0,40 s** (2,7-2,8 g/s); bakım gazı penceresi ve roll-on A'dan türetilir; nöromüsküler ayrı blok yok (yarış sürüşü önizlemeli) | first-order lag katmanı (tur süresinden bağımsız → inert) | R3 §4.1-4.4 |
| K9 | **Risk banner** | `gripUse` **μ_eff**'e normalize (100 % = sürücünün kendi tavanı); ikinci gösterge μ_peak oranı | mevcut μ_peak tabanlı eşik (gürültü tabanında) | R2 §5 risk 1 |
| K10 | **Doğrulama** | İki seviye: (a) sahibin Ducati Run036 → çizgi, lateral g, slip, roll-rate, pick-up, A/R kimliklendirme (R3 §6.3 tarifi + R2 §3.6 slip düzeltmesi); (b) BMW/R6 → viraj metrikleri (fren sayısı, min hız, build süresi), tur süresi bandı | yalnız tur süresiyle doğrulama (hatalar birbirini örtüyor) | R3 §6, R2 §3.6 |

## 1.1 Kullanıcı sapma onayı (2026-10-11, sentez sonrası)

K4/K5'teki "free-trajectory ve tam OCP ertelendi" kararına kullanıcı itiraz etti: "Do both and make
it a choice I can click to switch between." Sonuç: üç çözücü modu (Sürücü / Serbest yörünge /
Tam OCP), spec v2 §2.10. İdeal-sürücü çelişkisi mod ayrımıyla çözülür: kısıt 1-3 sürücü moduna
uygulanır, optimal modlar tavanı gösterir ve Δt ile koçluk görünümü sağlar. Varsayılan mod: Sürücü.

## 2. Çözülen çelişkiler

1. **g(s) şekli** (R2 MF vs R3 sinüs): MF seçildi (ölçülmüş katsayı). Sonuç: zirve-altı sürmek
   ucuz (s=0,6 → fren kuvvetinin %92'si), yani "risk" az kazandırır çok marj verir — ölçümle uyumlu
   (BMW 0,70→0,85 g = 0,83 s).
2. **A/R → s eşlemesi katsayıları** (R2 `0,45+0,45R` vs R3 `0,30+0,65R`): ikisi de "öneri". Spec'te
   başlangıç değeri R3'ün geniş aralığı, **kalibrasyon W4'te Ducati verisiyle** zorunlu; katsayılar
   `presets.ts`'te tek yerde, kaynak yorumuyla.
3. **Biniewicz lateral jerk β0** (23,51 tez vs 32,56 makale): tez değeri alınır, tam metinle teyit
   W3'ün görevi; preset yorumunda belirsizlik yazılır.
4. **FBGA portu** (R4 önerir): gerekli değil. Mevcut geçişler zaten forward-backward; FBGA'nın
   katkısı konveks olmayan zarf ve C++ hızı. Zarfımız konveks kalıyor. Ertelendi; MIT lisansı not.

## 3. Veri gerçeği (R1'in uyarısı)

BMW dosyasında yalnız hız, R6'da hız+gaz+vites var; **lean ve rpm hiçbir hızlı referansta yok.**
Lean, roll-rate, slip, DTC doğrulaması **yalnız sahibin Ducati kaydından** (1:35.8) yapılabilir.
Dolayısıyla "aynı A/R ile BMW presetinde ne çıkar" bir tahmindir, doğrulama değil.

## 4. Beklenen etkiler (tahmin, sim ile ölçülecek)

| Değişiklik | Tur süresi | Diğer |
|---|---|---|
| Stoppie+drag fren tavanı | −0,2…−0,5 s | K1 −1,42 g `brakingG` şişirmeden |
| Crown/hang-off yatış | 1000 presetinde lean-limitli hale gelir; hang-off ±%5 viraj hızı | `leanUsage` inert olmaktan çıkar |
| s_brake 1→0,6 | +0,3…0,8 s | fren izleri gerçekçi |
| s_lat 1→0,6 | +1,2 s | μ_peak ≈1,40'a yeniden kalibre gerekir |
| Viraj-olay modeli | ~0 | fren sayısı 16 → 7-14; geçiş 0,02 s → 0,4-2 s |
| Roll-rate kısıtı | şikanlarda + | K11-K13 bloğu |

## 5. Ertelenenler (spec v2 "deferred")

DEM eğim (isteğe bağlı seçenek, varsayılan kapalı), banking, tam MF, FBGA portu, free-trajectory
çizgi, kamber-kayma ayrımı (yalnız görselleştirme LUT), sunucu tarafı offline OCP ("ideal çizgi"
doğrulaması için).
