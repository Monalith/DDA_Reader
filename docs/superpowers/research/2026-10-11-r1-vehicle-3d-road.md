# R1 — Motosiklet modellemesi ve 3 boyutlu tek-iz (single-track) modelleme

Tarih: 2026-10-11. Kapsam: sahibin 1. ve 2. maddesi. Kodda değişiklik yapılmadı.
Arka plan: `specs/2026-10-09-virtual-rider-design.md`, `notes/2026-10-10-virtual-vs-real.md` §5,
mevcut `dda_lab/src/sim/solver.ts` (okundu: drag zaten frenlemeye yardım ediyor,
wheelie limiti `g·L/(2h)`, yatış limiti `tan(leanMax)`, stoppie limiti yok).

> **Veri uyarısı (brief ile çelişki).** Brief "speed, lean, long_g, rpm, tps @10 Hz" diyor.
> Repodaki dosyalarda: BMW (`serres_BMW_1-19-81.json`) yalnız `hiz_kmh` (+türevi `boylamsal_g`);
> R6 (`serres_R6_1-19-849.json`) `hiz_kmh`, `gaz_pct`, `vites` — meta: *"Yatış, fren basıncı ve
> devir yok."* Yani **yatış (lean) ve rpm hiçbir referans turda ölçülmüş değil.** Aşağıdaki
> "telemetriden gözlenebilir mi?" sütunu buna göre dürüstçe doldurulmuştur. Pist uzunluğu
> da 4–5 km değil **3186 m**.

---

## 1. Özet

1. **Tek öneri:** Çok-cisimli (multibody) bir modele geçme. QSS üç-geçişli çözücüyü koru, ama
   noktasal kütleyi **"QSS tek-iz + cebirsel yük transferi + roll-rate kısıtı"** basamağına çıkar.
2. Eklenecek dört şey, hepsi kapalı formda ve O(n): (a) ön/arka normal yük → **stoppie limiti**
   ve **gerçek CG konumlu wheelie limiti** (şu an `L/2` varsayımı), lean'de `h·cosφ` düzeltmesi;
   (b) **lastik crown yarıçapı + hang-off** ile gerçek yatış ↔ ideal yatış dönüşümü (≈ +5…7° /
   hang-off ile ≈ 0°); (c) **roll-rate (°/s) kısıtı** ek bir ileri/geri geçiş olarak — sahibin
   "agresiflik" parametresi buna bağlanır; (d) **kullanılan sürtünme = μ_peak·(1 − marj(risk))**
   — sahibin "risk" parametresi; lastik tavanda çalışmaz.
3. **3B yol:** Denklemler hazır (Lovato & Massaro 2022), QSS'e 3 satır ekler. Ama **Serres düz
   bir vadide**: EU-DEM'den örneklenen tur profili 19,5–27,3 m (toplam ~8 m), 50 m tabanlı eğim
   ±2,8 % — bu, DEM gürültüsüyle aynı mertebe. Banking (yan eğim) hiçbir açık DEM'den
   çıkarılamaz (≥ 0,1 m düşey doğruluk gerekir).
4. Bu yüzden 3B: **altyapıyı (g-bütçesi denklemleri, `slope/bank` kanalları = 0 varsayılan) şimdi
   ekle, veriyi erteleme.** Beklenen Serres etkisi tahminen ≤ 0,2–0,3 s/tur (Mugello'daki 4 s
   değil). Yükseklik ancak LiDAR/ölçüm gelirse açılmalı.
5. Whipple/Koenen modları (capsize/weave/wobble) tur süresini belirlemez → ertele.
6. Rider-as-separate-body: tek parametre (`hangOffM`, ~0,1–0,3 m) olarak **değer** — yatış
   tavanını ~6° kaydırır, şu an "inert" olan `leanUsage` slider'ını yeniden anlamlı kılar.

---

## 2. Model merdiveni

| Basamak | DOF | Alt basamağın veremediği tahmin | Maliyet (tur başı, tarayıcı) | Parametreler | Telemetriden gözlenebilir mi? (BMW: hız; R6: hız+tps+vites) | 50 ms bütçesine sığar mı? |
|---|---|---|---|---|---|---|
| **0. Noktasal kütle QSS (mevcut)** | 1 (s boyunca v) | — | < 1 ms (3×O(n), n≈1600) | m, P, CdA, μ, φ_max, a_brake | m, P, CdA: hız izinden (düzlük ivmesi, top speed). μ: yalnız *ima* (geometri güvenilmez) | Evet |
| **1. + Cebirsel boylamsal yük transferi** | 1 (pitch quasi-statik, ek durum yok) | Stoppie limiti (fren arka lastiği kaldırır), gerçek-CG wheelie limiti, aero ile hızla artan fren tavanı (K1'deki −1,42 g), ön/arka lastik ayrı kapasite | < 1 ms | + b (arka temas→CG yatay), h, h_D, (lift) | Kısmen: wheelie/stoppie platosu `long_g` tepesinde görülür (BMW K1 −1,42 g @250 km/h ↔ drag katkısı ≈ 0,3 g) | Evet |
| **2. QSS tek-iz (roll'lu) — ÖNERİLEN** | 1 + cebirsel φ(s); roll-rate kısıtı ek geçiş | Gerçek yatış açısı (crown, hang-off, jiroskop), φ̇ limiti → giriş/çıkışta zaman kaybı, tek fren/tek gaz geçişi zorunluluğu, lean ↔ grip ayrımı | 1–3 ms (5 geçiş) | + t (crown yarıçapı), d_r ve m_r (hang-off), I_w/r (jiroskop), φ̇_max | φ ölçülmedi. φ̇ ve t gözlenemez; literatür/preset değeri. R6 tps → gaz açma noktası doğrulanabilir | Evet |
| **3. Sharp 1971** | 4 (lateral, yaw, roll, steer) + lastik relaxation durumları; lineer, sabit hız | Capsize/weave/wobble özdeğerleri, direksiyon torku, stabilite vs hız | Özdeğer: µs; zaman-uzayı tur: 1 kHz × 80 s ≈ 80k adım + sürücü kontrolcüsü (iteratif) → 10–100+ ms | + kütle/atalet tensörleri (ön/arka çerçeve), trail, kaster, lastik cornering/camber stiffness, relaxation length | Hayır | Özdeğer evet; tur simülasyonu hayır (kontrolcü ayarı gerekir) |
| **4. Sharp 1994** | Sharp 1971 + çerçeve burulma esnekliği, sürücü üst gövde roll'u, steer damper | Wobble/weave'in esneklik ve sürücüye duyarlılığı | Benzer, daha sert (stiff) | + burulma rijitliği, sürücü atalet/sönüm | Hayır | Tur simülasyonu hayır |
| **5. Sharp–Evangelou–Limebeer 2004** (Sharp & Limebeer 2001 tabanlı) | ~11–13 (süspansiyonlar, tekerlek dönmeleri, sürücü), nonlineer, Magic Formula lastik, aero | Büyük yatışta trim edilmiş viraj stabilitesi, fren/gaz altında weave, süspansiyon yük salınımı | Simulasyon: saniyeler (native); JS'te ~0,1–1 s/tur | Onlarca: süspansiyon k/c, MF katsayıları (~20+), ataletler | Hayır | Hayır |
| **6. Cossalter & Lot FastBike (2002)** | 11 (natural coordinates), nonlineer, toroidal lastik | Gerçek-zamanlı sürüş simülatörü; aynı fizik + optimal manevra (Bobbo 2009) | Gerçek zamanlı (native Fortran); optimal kontrol ile tur: dakikalar–saatler | FastBike veri seti (~100 parametre) | Hayır | Hayır |
| **7. Minimum-tur-süresi optimal kontrol, 3B pist** (Leonelli & Limebeer 2020; Lovato & Massaro 2022 QSS-OCP) | 6–13 + yol şeridi (ribbon) | Optimal çizgi ve kontroller birlikte; 3B yol etkisi | NLP çözümü: dakikalar (IPOPT/GPOPS-II) | Yukarıdakiler + 3B pist ribbon'u | Hayır | Hayır (sunucu tarafı offline olabilir) |

**Not — Whipple/Koenen modları.** Capsize (düşük hızda yavaş ıraksama), weave (~2–4 Hz, yüksek
hızda sönümü azalan yalpa) ve wobble (~6–10 Hz direksiyon titreşimi) Meijaard vd. (2007) ve
Koenen (1983) ile tanımlı stabilite modlarıdır. **Tur süresi simülatörü için önemsizdirler:**
yarış motoru bu modların kararlı (veya sürücünün stabilize ettiği) bölgesinde sürülür; QSS
"stabil mi" sorusunu değil "ne kadar hızlı" sorusunu yanıtlar. Ancak dinamik/oyun simülasyonunda
(tank-slapper, fren altında weave) belirleyicidirler. Limebeer & Sharp (2006) bunları viraj
ortası ve fren altında da inceler; tasarım/kurulum aracı için anlamlı, DDA Lab için değil.
**Ertelenir.**

---

## 3. Denklemler

Semboller (SI): m = toplam kütle (motor+sürücü), g = 9,81, p = dingil mesafesi (wheelbase),
b = arka temas noktasından CG'ye yatay mesafe (p − b = ön temastan CG'ye), h = CG yüksekliği
(dik konumda), h_D = aero kuvvet uygulama yüksekliği, F_D = ½ρ·CdA·v², F_L = aero lift
(motor için ≈0, istenirse), t = lastik crown (kesit) yarıçapı, φ = motor roll açısı,
φ_i = ideal roll = atan(a_y/g), a_x = boylamsal ivme (+ hızlanma), d = −a_x (toplam yavaşlama).

### 3.1 Normal yükler ve boylamsal limitler (düz yol, dik)

Moment dengesi (D'Alembert, CG'de atalet kuvveti):

```
N_f = ( m·g·b − m·a_x·h − F_D·h_D ) / p
N_r = ( m·g·(p − b) + m·a_x·h + F_D·h_D ) / p
N_f + N_r = m·g            (lift ihmal)
```

**Wheelie limiti** (N_f ≥ 0, hızlanma, a_x = (F_drive − F_D)/m):

```
a_x ≤ ( g·b − F_D·h_D/m ) / h
```

Mevcut kod `g·p/(2h)` kullanıyor, yani b = p/2 varsayıyor ve drag'in ön lastiği hafiflettiğini
yok sayıyor. Örnek (S1000RR+sürücü, tahmini p = 1,44 m, b = 0,70 m, h = 0,62 m):
g·b/h = 1,11 g (kod: 1,16 g). Drag ön lastiği hafiflettiği için wheelie tavanı hızla düşer,
ama yüksek hızda motor gücü zaten çok daha önce bağlar; wheelie limiti pratikte yalnızca
düşük viteste (≲ 120 km/h) aktiftir.

**Stoppie limiti** (N_r ≥ 0, fren, d = (F_brake + F_D)/m):

```
d ≤ ( g·(p − b) + F_D·h_D/m ) / h
→ h_D ≈ h ise:  F_brake/m ≤ g·(p − b)/h      (drag bunun ÜSTÜNE eklenir)
```

Örnek: g·0,74/0,62 = **1,19 g** lastik-fren tavanı; 250 km/h'de + 0,33 g drag ⇒ toplam
≈ 1,52 g mümkün. Bu, BMW turundaki **tek −1,42 g olayının (K1, 250 km/h'den)** ve diğer
virajlardaki −0,68…−1,07 g'nin fiziksel açıklamasıdır (H3 bulgusu): sabit `brakingG` yerine
**hıza bağlı tavan = min(μ_use·g, stoppie) + drag**. (Mevcut kod drag'i frene ekliyor ama
stoppie limiti yok; `min(brakingG, μ)` bunun yerini tutuyor.)

**Lean altında.** Motor φ kadar yatıkken CG'nin yere dik yüksekliği
`h_φ = t + (h − t)·cos φ` (crown düzeltmeli; t=0 için h·cosφ). Pitch momenti bu yükseklikle
oluşur, dolayısıyla:

```
a_wheelie(φ) = g·b / h_φ        a_stoppie(φ) = g·(p − b) / h_φ
```

φ = 45°'de h_φ ≈ 0,46 m → limitler ~%35 artar; pratikte lean'de friction ellipse önce bağlar,
yani lean düzeltmesi esas olarak **çıkışta (φ ~ 20–35°) gaz açarken** önemlidir.
Ön/arka ayrı sürtünme istenirse: |F_x,f| ≤ μ_use·N_f, |F_x,r| ≤ μ_use·N_r (fren ön ağırlıklı,
sürüş yalnız arka) — QSS'te cebirsel, ek maliyet yok.

### 3.2 Gerçek yatış açısı (steady turning)

İdeal: `tan φ_i = a_y / g = v²·κ / g`.

**Crown (lastik kesit yarıçapı) düzeltmesi** (Cossalter 2006; Cossalter, Doria & Lot 1999):
temas noktası crown merkezinin altına kayar; denge:

```
(h − t)·sin(φ − φ_i) = t·sin φ_i      ⇒   φ = φ_i + asin( t·sin φ_i / (h − t) )
```

**+ Hang-off (sürücünün yanal CG kayması).** Sürücü kütlesi m_r, motor merkez düzlemine dik
d_r kadar içeride ⇒ birleşik CG ofseti `e = m_r·d_r / m`. Türetme (bu dokümanda yapıldı,
yukarıdakinin genellemesi):

```
(h − t)·sin δ + e·cos δ = t·sin φ_i ,   δ = φ − φ_i
δ = asin( t·sin φ_i / R ) − α ,   R = √((h−t)² + e²),  α = atan2(e, h − t)
```

**+ Jiroskop** (tekerlek açısal momentumu; Cossalter): denge momentine `(I_f/r_f + I_r/r_r)·v²κ`
eklenir ⇒

```
tan φ_i,gyro = (v²κ/g) · ( 1 + (I_f/r_f + I_r/r_r) / (m·h) )
```

**Tipik düzeltme (h = 0,60 m birleşik CG, t = 0,08 m, m = 270 kg; türetilmiş sayılar):**

| φ_i (ideal) | crown (t=0,06) | crown (t=0,08) | crown t=0,08 + hang-off e=0,07 m (m_r 75 kg, d_r 0,25 m) | jiroskop (I_f 0,6, I_r 0,8 kg·m², r 0,3 m) |
|---|---|---|---|---|
| 30° | +3,2° | +4,4° | −3,2° | +0,7° |
| 45° | +4,5° | +6,2° | −1,4° | +0,8° |
| 50° | +4,9° | +6,8° | −0,9° | +0,8° |

(Atalet/crown değerleri tipik büyüklük; doğrulanmış katalog değeri değil.)

**DDA Lab'a sonucu:** Şu an `aLatMax = min(μ, tan(φ_max))`. Lastik tavanı φ_max = 58° *gerçek*
motor yatışıdır; hang-off'suz bir motor için (t = 0,08, h = 0,60) bu ≈ 51,1° ideal açıya, yani a_y ≈ 1,24 g'ye
karşılık gelir — μ = 1,33'ün altında. Yani **crown düzeltmesi eklenince `leanUsage` artık inert
olmaz** ve hang-off parametresi lean-limitli makinelerde (250/600) doğrudan viraj hızını belirler.
Doğru kural: `φ_bike(φ_i, t, e) ≤ φ_max_tyre` → φ_i,max'ı ters çözerek (monoton; 10 iterasyonluk
bisection ya da önceden tablolanmış) a_lat sınırı.

### 3.3 Roll-rate kısıtı (sahibin kısıtı 3 — "agresiflik")

φ(s) = φ_bike(v(s), κ(s)). Zaman türevi `dφ/dt = v·dφ/ds`. Kısıt `|dφ/dt| ≤ φ̇_max(aggr)`.
QSS'te uygulama: envelope v(s) bulunduktan sonra φ(s)'i hesapla; kısıtı ihlal eden bölgelerde
(şikan, S geçişleri) v'yi düşür: `v ≤ φ̇_max / |dφ/ds|` (sabit nokta: v değişince φ değişir —
2–3 iterasyon yeterli, her biri O(n)). Ardından fren/gaz geçişlerini yeniden çalıştır. Bu,
sahibin kısıt 1'ini (virajda tek fren → tek gaz geçişi) de destekler: roll-in fren bırakılırken,
roll-out gaz açılırken olur; φ̇ limiti geçiş sürelerini *fiziksel* kılar, `rider.ts`'teki
sonradan eklenen gecikmeler gibi tur süresinden bağımsız değildir.
Literatür: Biral & Lot (2009) g-g yorum modeli ve Cossalter vd. (1999) manevra kabiliyeti
çalışmaları roll hızını geçiş sınırlayıcı olarak kullanır. Yarışta tipik roll hızı değerini
(°/s) birincil kaynakta **doğrulayamadım** — preset değeri sahibin kendi verisinden (ileride
IMU'lu bir tur) kalibre edilmeli.

### 3.4 Kontrollü kayma (sahibin kısıtı 2 — "risk")

QSS seviyesinde slip açısı/oranı durumları yoktur; eşdeğeri, lastik eğrisinin tepe noktasının
altında çalışmaktır: `μ_use = μ_peak · (1 − m_risk)`, `m_risk ∈ [0, ~0,15]`. Friction ellipse
μ_use ile kurulur. Slip ↔ μ eşlemesi (örn. Magic Formula'nın tepe-altı dalı) yalnızca **gösterim**
için kullanılabilir (hangi slip açısına karşılık geldiğini raporlamak) — çözücüye girmez.
Bu, diğer araştırma konusunun (lastik) kapsamıdır; burada sadece arayüz tanımlanır.

### 3.5 3B yol: g-bütçesi (QSS'e uygulanabilir)

Yol "şerit" (ribbon) olarak: s boyunca heading θ, eğim (slope) σ (yokuş yukarı +), banking β
(dönüş merkezine doğru alçalan yüzey +, işaret κ ile tutarlı). Açısal hızlar s'ye göre
(Marconi & Massaro 2020; Lovato, Massaro & Limebeer 2021):

```
κ  = cos σ·cos β·θ' − sin β·σ'        (yol düzlemindeki / geodezik eğrilik → yanal)
ν  = cos σ·sin β·θ' + cos β·σ'        (normal eğrilik → yük; σ' > 0 çukur/sıkışma)
τ  = −sin σ·θ' + β'                   (burulma — QSS'te ihmal edilebilir, roll dinamiğine girer)
```

Araç çerçevesinde lastiklerin karşılaması gereken ivmeler ve etkin yerçekimi
(Lovato & Massaro 2022, eş. formu):

```
ã_x = a_x + g·sin σ                    (yokuşta boylamsal bütçeden yer)
ã_y = v²·κ − g·cos σ·sin β             (lehte banking yanal talebi düşürür)
g̃   = g·cos σ·cos β + v²·ν             (yola dik etkin yük; tepede v²ν<0 → "hafifleme")
```

QSS içinde yapılacak tek değişiklik: friction ellipse ve lean hesabında **g yerine g̃**,
a_x yerine ã_x, a_y yerine ã_y:

```
(ã_x / (μ_use·g̃))² + (ã_y / (μ_use·g̃))² ≤ 1
tan φ_i (yola göre) = ã_y / g̃
v_lat(s): v²κ ≤ μ_use·(g cosσ cosβ + v²ν) + g cosσ sinβ   →   v² ≤ (μ_use·g cosσ cosβ + g cosσ sinβ) / (κ − μ_use·ν)
geri/ileri geçişte: dv²/ds = 2·(a_x,tyre − g sin σ − F_D/m)
wheelie/stoppie: g → g̃ (ve sin σ terimi yerçekimi bileşeni olarak)
```

(κ ≤ μ_use·ν ise yanal sınır yoktur — sıkışmada aşırı yük, pratikte görülmez.) Hepsi s başına
birkaç flop; maliyet artışı ihmal edilebilir.

**Etki büyüklüğü (literatür):**

| Çalışma | Pist | Sonuç |
|---|---|---|
| Marconi & Massaro 2020 | Mugello (motosiklet) | 3B 106,030 s; 2D 110,101 s (+4,17 s); yalnız eğim 109,933 s; yalnız banking 106,053 s → **etkinin neredeyse tamamı banking'den**; viraj ortasında 20 km/h'ye varan fark |
| Lovato & Massaro 2022 | Mugello / Catalunya | Motosiklet "düz Mugello"da +4,0 s; araç "düz Catalunya"da −0,9 s |
| Biniewicz & Pyrz 2024 | Road Atlanta (Supersport) | 3B-yerel (1 m DEM) 89,658 s; 3B-global (1″ DEM) 90,844 s; 2D 91,211 s; gerçek en iyi 90,485 s. Kaba DEM ile virajlarda ±3,0–3,6 m/s (±11–13 km/h) sapma |

Önemli ders (Biniewicz & Pyrz): **kaba DEM, düz modelden daha iyi değil** — yanlış eğim/banking
optimal manevrayı yanlış yerde değiştirir.

### 3.6 Eğim hatası → fren mesafesi hatası

`D = (v₁² − v₂²) / (2·(a_b + g·sin σ))`. Küçük hata e (radyan ≈ eğim oranı):
`ΔD/D ≈ −e / (a_b/g)`. a_b = 1,1 g ile **%1 eğim hatası → %0,9 mesafe hatası.**
250 → 100 km/h (D ≈ 188 m): %1 → 1,7 m; %3 → 5 m. Zaman cinsinden: aynı fren bölgesinde
~0,01–0,03 s. Gaz tarafında daha büyük: 200 km/h'de net sürüş ivmesi ~0,3–0,4 g iken %2 eğim
0,02 g = ivmenin %5–7'si.

---

## 4. DEM veri kaynakları (Serres için)

| Kaynak | Yatay çöz. | Düşey doğruluk | Erişim / tarayıcı | Lisans | Serres'te durum |
|---|---|---|---|---|---|
| **Copernicus GLO-30** | 30 m (1″) | ICESat'a karşı küresel RMSE 1,68 m, LE90 2,17 m (EGU23-10090); başka çalışmalarda 2,3–3,8 m RMSE. **DSM** (yüzey: ağaç/bina dahil) | AWS `copernicus-dem-30m` COG, HTTP Range çalışıyor; **CORS başlığı yok** (2026-10-11 test) → FastAPI köprüsünde okunmalı | Copernicus DEM lisansı, ücretsiz, atıf zorunlu | Kullanılabilir, sunucu tarafı |
| **SRTM 1″ (NASADEM)** | 30 m | ~4–6 m RMSE (benchmark çalışmalarda 4,4 m) | NASA Earthdata (giriş gerekir) / OpenTopography (API key) | Kamu malı | Copernicus'tan zayıf |
| **EU-DEM v1.1** | 25 m | 2014 validasyonu: 2,9 m RMSE (ICESat, v1.0); Orta Makedonya GNSS: 2,7 m (Mouratidis & Ampatzidis 2019); v1.1 spesifikasyonu ±7 m | Copernicus Land (indirme); **Terrarium karolarının Serres kaynağı budur** | Copernicus, açık | Terrarium üzerinden zaten erişilebilir |
| **AWS Terrain Tiles (Terrarium/Mapzen)** | Karo z15'te ~3,6 m/px, ama kaynak yeniden örneklenmiş | Kaynağınki (Serres: `eudem_dem_5deg_n40e020.tif`, başlık `x-amz-meta-x-imagery-sources`) | `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png`; **`Access-Control-Allow-Origin: *` doğrulandı** → canvas'ta doğrudan çözülür: `h = R·256 + G + B/256 − 32768` | Atıf zorunlu (kaynak listesi) | **Test edildi** (aşağıda) |
| **Ulusal LiDAR / Hellenic Cadastre DEM** | ~5 m (kadastro DEM'i; FIG 2010 sunumu 50 cm ortofoto + DEM'den söz ediyor) | **doğrulanmadı** | Ktimatologio portalı (WMS/ücretli olabilir) | doğrulanmadı | Yunanistan'da genel açık 1 m LiDAR bulunamadı |
| **Pist ölçümü / çok turlu GNSS (RTK)** | ~1 m | cm–dm (RTK) | Yerinde | — | Banking için tek gerçekçi yol |

**Serres prob ölçümü (bu çalışmada, Terrarium z15, BMW referans çizgisi üzerinde 5 m adım):**
yükseklik 19,5–27,3 m (aralık 7,8 m); 50 m tabanlı eğim min −2,76 %, max +2,80 %, |p95| 2,42 %.
Serres, Strymon ovasında düz bir pisttir; bu eğimler DEM'in kendi gürültüsüyle aynı mertebededir.

**30 m DEM eğim için anlamlı mı?** İlişkisiz düşey gürültü σ_h ile L tabanlı eğim hatası
σ_grade ≈ √2·σ_h / L. σ_h = 2 m: L = 50 m → %5,7; L = 100 m → %2,8; L = 300 m → %0,9.
(Gerçek DEM hatası uzamsal olarak korelasyonludur, bu yüzden pratikte biraz daha iyi; ama
DSM'de pist kenarındaki ağaç/tribün yükseklikleri ek sapma getirir.) Sonuç: **30 m DEM yalnızca
≥ 200–300 m dalga boyundaki eğimi** (uzun düzlüklerin yokuş/inişi) güvenilir verir; viraj
ölçeğinde (50 m) gürültüdür.

**Banking için?** 12 m genişlikte 1° banking = 0,21 m düşey fark. Gerekli: σ_h ≲ 0,1 m ve
≤ 1–2 m yatay çözünürlük → yalnız LiDAR (σ_bank ≈ √2·0,1/12 ≈ %1,2 ≈ 0,7°) veya yer ölçümü.
**Hiçbir açık 25–30 m DEM banking veremez.** Mugello sonucuna göre 3B etkinin çoğu banking'den
geldiği için, Serres'te banking verisi olmadan 3B'nin kazancı sınırlıdır.

---

## 5. DDA Lab için uygulanabilirlik

### Şimdi benimse (tahmini toplam ek maliyet: < 3 ms/tur)

1. **Yük transferli limitler** (§3.1): `cgHeightM` yanında `cgRearM` (b) parametresi;
   wheelie = g·b/h_φ − drag terimi; **stoppie = g·(p−b)/h_φ + F_D/m** — fren tavanı hızla
   artar. Beklenen etki: K1 gibi yüksek hızlı fren bölgelerinde −1,4…−1,5 g'yi `brakingG`'yi
   şişirmeden üretir; düşük hızlı firenlerde ~1,1–1,2 g'de kalır. H3'teki "ya bir virajda doğru,
   ya 13'ünde yanlış" ikilemini çözer. Lap etkisi büyüklük olarak H5'teki `brakingG` 1,1→1,4
   probunun (−1,0 s) bir kısmı, tahminen −0,2…−0,5 s (tahmin, ölçülmedi).
2. **Crown + hang-off + jiroskop ile yatış** (§3.2): `tyreCrownM` (t, ~0,06–0,09) ve
   `hangOffM` (d_r, 0–0,3) parametreleri; yatış tavanı gerçek motor yatışına uygulanır.
   Etki: 1000 presetinde φ_max 58° → ideal ~51° (hang-off'suz) → lean-limitli; hang-off
   ile tekrar ~58° ideal. Yani **hang-off slider'ı viraj hızını ±%5 civarı değiştirir**;
   `leanUsage`'ın inert olma sorunu kalkar. Kanal çıktısı `lean` artık gerçek motor yatışıdır
   (IMU'lu tur geldiğinde doğrudan karşılaştırılabilir).
3. **Roll-rate kısıtı** (§3.3) — `aggressiveness → φ̇_max`. Etki şikanlarda ve S'lerde
   (Serres K11–K13 bölgesi, notta +1,4 s'lik tek blok) görülür; tek virajlarda giriş/çıkış
   geçişlerini uzatır.
4. **μ_use = μ_peak(1 − m_risk)** (§3.4) — `riskTaking → m_risk`. Mevcut risk banner'ı
   (%100 friction circle) anlamını kazanır: banner μ_peak'e göre, çözücü μ_use'a göre çalışır.
5. **3B altyapı, veri olmadan** (§3.5): `slopeRad[]`, `bankRad[]`, `nu[]` kanalları, varsayılan 0;
   g̃/ã_x/ã_y denklemleri çözücüde. Sıfır veride sonuç bit-bit aynı kalmalı (test).

### Ertele

- **DEM'den eğim:** Terrarium (CORS açık) ile 300 m'lik low-pass eğim profili teknik olarak
  hemen alınabilir, ama Serres'te ~8 m'lik toplam rölyef ve gürültü düzeyindeki eğimle
  beklenen etki tahminen ≤ 0,2–0,3 s/tur ve işaretinden emin olunamaz. Yalnızca "eğimli pist"
  (ileride Mugello benzeri) yüklendiğinde açılacak bir seçenek olarak tasarla; varsayılan kapalı.
- **Banking:** LiDAR/ölçüm olmadan yapılmamalı (Biniewicz & Pyrz: kaba veri, düz modelden
  kötü olabilir).
- **Sharp 1971 ve üstü / FastBike / optimal kontrol:** Parametreleri telemetriden gözlenemez,
  tarayıcı bütçesine sığmaz, ve DDA Lab'ın asıl hatası (notta §5: geometri/merkez çizgi
  doğruluğu, μ'nün ±2,5 s/0,1 etkisi) bu basamaklarla çözülmez. "Extension seam" korunsun;
  ileride sunucu tarafında offline bir OCP (Lovato & Massaro QSS-OCP tarzı) "ideal çizgi
  doğrulama" için düşünülebilir.
- **Stabilite modları:** Tur süresine etkisi yok.

### Dürüst sınırlar

- Yatış ve roll hızı **hiçbir referans turda ölçülmedi**; §3.2–3.3 parametreleri literatür/
  preset değerleriyle başlar ve IMU'lu bir tur gelene kadar doğrulanamaz.
- Yük transferi parametresi b, h: üretici ağırlık dağılımı + tahmini sürücü; h yalnızca
  wheelie/stoppie platosundan dolaylı kalibre edilebilir (gaz tarafında R6 `gaz_pct` = 100 iken
  `boylamsal_g` platosu düşük viteslerde bir aday).
- Bu dokümandaki sayısal düzeltme tabloları (§3.2) türetilmiş modeldir, ölçüm değildir.

---

## 6. Kaynaklar

| # | Kaynak | DOI / URL | Etiket |
|---|---|---|---|
| 1 | Sharp, R.S. (1971). The Stability and Control of Motorcycles. *J. Mech. Eng. Sci.* 13(5), 316–329 | 10.1243/JMES_JOUR_1971_013_051_02 | akademik |
| 2 | Sharp, R.S. (1994). Vibrational modes of motorcycles and their design parameter sensitivities. IMechE konf. (Vehicle NVH and Refinement) | DOI bulunamadı | akademik — doğrulanmadı (künye ikincil kaynaktan) |
| 3 | Sharp, R.S., Evangelou, S., Limebeer, D.J.N. (2004). Advances in the modelling of motorcycle dynamics. *Multibody Syst. Dyn.* 12(3), 251–283 | 10.1023/B:MUBO.0000049195.60868.a2 | akademik |
| 4 | Limebeer, D.J.N., Sharp, R.S. (2006). Bicycles, motorcycles, and models. *IEEE Control Systems* 26(5) | 10.1109/MCS.2006.1700044 | akademik |
| 5 | Cossalter, V., Lot, R. (2002). A motorcycle multi-body model for real time simulations based on the natural coordinates approach (FastBike, 11 DOF). *Veh. Syst. Dyn.* 37(6), 423–447 | 10.1076/vesd.37.6.423.3523 | akademik |
| 6 | Cossalter, V., Doria, A., Lot, R. (1999). Steady turning of two-wheeled vehicles. *Veh. Syst. Dyn.* 31(3), 157–181 | 10.1076/vesd.31.3.157.2013 | akademik |
| 7 | Cossalter, V., Lot, R., Peretto, M. (2007). Steady turning of motorcycles. *Proc. IMechE D* 221 | 10.1243/09544070JAUTO322 | akademik |
| 8 | Cossalter, V. (2006). *Motorcycle Dynamics*, 2. baskı (crown ve jiroskop düzeltmesi); çevrimiçi özet: dynamotion.it "Gyroscopic effects" | https://dynamotion.it/dinamoto/8_on-line_papers/effetto%20giroscopico/Effettigiroscopici_eng.html | akademik (kitap; formül metni sayfada görsel, kitaptan doğrulanmadı) |
| 9 | Meijaard, J.P., Papadopoulos, J.M., Ruina, A., Schwab, A.L. (2007). Linearized dynamics equations for the balance and steer of a bicycle: a benchmark and review. *Proc. R. Soc. A* 463, 1955–1982 | 10.1098/rspa.2007.1857 | akademik |
| 10 | Koenen, C. (1983). The dynamic behaviour of a motorcycle when running straight ahead and when cornering. Doktora tezi, TU Delft | — | akademik — doğrulanmadı (çevrimiçi kontrol edilmedi) |
| 11 | Leonelli, L., Limebeer, D.J.N. (2020). Optimal control of a road racing motorcycle on a three-dimensional closed track. *Veh. Syst. Dyn.* 58(8), 1285–1309 | 10.1080/00423114.2019.1617886 | akademik |
| 12 | Marconi, E., Massaro, M. (2020). The effect of suspensions and racetrack three-dimensionality on the minimum lap time of motorcycles. (Konf., s. 1368–1377; Mugello sayıları buradan) | https://www.research.unipd.it/retrieve/e14fb26f-aaf1-3de1-e053-1705fe0ac030/ | akademik |
| 13 | Lovato, S., Massaro, M. (2022). A three-dimensional free-trajectory quasi-steady-state optimal-control method for minimum-lap-time of race vehicles. *Veh. Syst. Dyn.* 60, 1512–1530 (g̃, ã_x, ã_y denklemleri) | 10.1080/00423114.2021.1878242 | akademik |
| 14 | Lovato, S., Massaro, M., Limebeer, D.J.N. (2021). Curved-ribbon-based track modelling for minimum lap-time optimisation. *Meccanica* 56, 2139–2152 | 10.1007/s11012-021-01387-3 | akademik |
| 15 | Veneri, M., Massaro, M. (2020). A free-trajectory quasi-steady-state optimal-control method for minimum lap-time of race vehicles. *Veh. Syst. Dyn.* 58, 933–954 | 10.1080/00423114.2019.1608364 | akademik |
| 16 | Perantoni, G., Limebeer, D.J.N. (2015). Optimal control of a Formula One car on a three-dimensional track — Part 1: Track modeling and identification. *J. Dyn. Syst. Meas. Control* 137, 051018 | 10.1115/1.4028253 | akademik |
| 17 | Massaro, M., Limebeer, D.J.N. (2021). Minimum-lap-time optimisation and simulation (derleme). *Veh. Syst. Dyn.* 59, 1069–1113 | 10.1080/00423114.2021.1910718 | akademik |
| 18 | Limebeer, D.J.N., Warren, E. (2023). A review of road models for vehicular control. *Veh. Syst. Dyn.* 61, 1449–1475 | 10.1080/00423114.2022.2085582 | akademik |
| 19 | Biniewicz, J., Pyrz, M. (2024). Influence of the Road Model on the Optimal Maneuver of a Racing Motorcycle. *Applied Sciences* 14(10), 4006 | 10.3390/app14104006 | akademik |
| 20 | Biniewicz, J., Pyrz, M. (2024). A quasi-steady-state minimum lap time simulation of race motorcycles using experimental data. *Veh. Syst. Dyn.* 62, 372–394 | 10.1080/00423114.2023.2170256 | akademik |
| 21 | Lot, R., Biral, F. (2014). A curvilinear abscissa approach for the lap time optimization of racing vehicles. *IFAC Proc. Vol.* 47(3), 7559–7565 | 10.3182/20140824-6-ZA-1003.00868 | akademik |
| 22 | Bobbo, S., Cossalter, V., Massaro, M., Peretto, M. (2009). Application of the "Optimal Maneuver Method" for enhancing racing motorcycle performance. *SAE Int. J. Passeng. Cars–Mech. Syst.* 1, 1311–1318 | 10.4271/2008-01-2965 | akademik |
| 23 | Biral, F., Lot, R. (2009). An interpretative model of g-g diagrams of racing motorcycle. ICMEM konf. | DOI yok | akademik — doğrulanmadı (yalnız atıf listesinden) |
| 24 | Massaro, M., Marconi, E. (2018). The effect of engine spin direction on the dynamics of powered two wheelers. *Veh. Syst. Dyn.* 56, 604–620 | 10.1080/00423114.2017.1397277 | akademik |
| 25 | EGU23-10090 (2023). Copernicus DEM küresel validasyonu (ICESat: RMSE 1,68 m, LE90 2,17 m) | https://meetingorganizer.copernicus.org/EGU23/EGU23-10090.html | akademik (konf. özeti) |
| 26 | DHI GRAS / EEA (2014). EU-DEM statistical validation (2,9 m RMSE) | https://ec.europa.eu/eurostat/documents/7116161/7172326/Report-EU-DEM-statistical-validation-August2014.pdf | endüstri |
| 27 | Mouratidis, A., Ampatzidis, D. (2019). European Digital Elevation Model validation against extensive GNSS in Central Macedonia. *ISPRS IJGI* 8(3), 108 | 10.3390/ijgi8030108 | akademik |
| 28 | Mapzen (2017). Terrain tile service / AWS Terrain Tiles (Terrarium formatı, kaynaklar) | https://mapzen.com/blog/terrain-tile-service/ | endüstri |
| 29 | Bu çalışmanın kendi ölçümleri (2026-10-11): Terrarium CORS başlığı, Serres karo kaynağı (`eudem_dem_5deg_n40e020.tif`), Copernicus AWS COG'da CORS yokluğu, Serres yükseklik profili | — | birincil ölçüm |

Not: Sharp & Limebeer (2001) "A motorcycle model for stability and control analysis",
*Multibody Syst. Dyn.* 6(2), 123–142 — SEL 2004'ün kaynakçasında görüldü, DOI kontrol edilmedi.
Yarış roll hızı (°/s) için birincil kaynak bulunamadı.
