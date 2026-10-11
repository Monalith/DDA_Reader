# Sanal sürücü v2 — tasarım spec'i (sürücü modeli yeniden gözden geçirme)

Tarih: 2026-10-11. Durum: **TASLAK, kullanıcı onayı bekliyor.**
Önceki spec: `2026-10-09-virtual-rider-design.md` (v1). Seçim gerekçesi: `notes/2026-10-11-model-selection.md`.
Araştırma: `research/2026-10-11-r1..r4-*.md`.

## 0. Bağlayıcı kısıtlar (kullanıcı, 2026-10-11)

1. Bir viraj kesitinde **tek fren ve tek gaz geçişi**. Sürekli gaz-fren yok. Simülasyon viraj
   olaylarından (fren noktası → turn-in → apex → gaz noktası → çıkış) üretilir.
2. Lastik **zirve-altı slip**'te çalışır. İzin verilen slip bir **sürücü** parametresidir.
3. **Agresiflik** ve **risk alma** iki üst-parametredir; yatma hızını (roll rate) ve izin verilen
   slip'i belirler, diğer fizik sliderları bunlardan türetilir.

Değişmeyen temel kısıt (v1): çıktı sıradan bir `Session`; slider hareketinde < ~50 ms;
parametreler DDA kanallarından gözlemlenebilir olmalı.

---

## 1. As-built: kodun bugünkü hali (v1 spec'ten sapmalar)

Bu bölüm v1 spec'i kodla eşitler. `feature/virtual-rider` @ 3030215, 13 modül, 456 test.

| v1 spec dedi | Kod yapıyor | Not |
|---|---|---|
| κ = eğrilik dağılım şekli (C↔V) | κ = min-eğrilik / min-mesafe çizgi **karışımı** (12bbc65); 20 m eğrilik ölçeği, 30 m GPS yumuşatma, dead band | v2'de kalır |
| `brakingG` tek fren tavanı | `min(brakingG, μ)`; **+ `brakeRiseGps`** jerk sınırı (4 iterasyon); **+ aero/rolling frenlemeye yardım eder**; **+ `trailBrakeDepth` / `trailBrakeProfile`** iki ekseni (`brakeShare`) | v2'de A/R'den türetilir |
| TC = sabit çarpan | TC = lateral kullanıma orantılı kesme | kalır |
| lean işareti tanımsız | sol = **negatif** (uygulama konvansiyonu) | kalır |
| risk yok | `risk.ts`: `gripUse > 1,05` banner | v2: μ_eff'e normalize |
| 4 test dosyası | 13 test dosyası (`simSerres`, `simLongG`, `simRisk`, `simStore`, `simLayers`…) | |
| rider.ts = basit lag | lag + dead-band + **olay birleştirme sezgiselleri** (`MERGE_GAP_S`, `SAME_CORNER_*`, `MIN_EVENT_S`) | v2'de **kaldırılır**, yerine segmentasyon |

Bilinen açıklar (`notes/2026-10-10-virtual-vs-real.md` §5): köşe hızları 11-15 km/h sapma
(geometri), gerçek lateral g bilinmiyor, 16 fren vs 7-14, geçiş şekli step, risk eşiği gürültüde,
κ doğrulanmamış.

---

## 2. To-be: v2 mimarisi

```
TrackModel + Corridor ──► line.ts (κ-çizgisi, DEĞİŞMEZ) ──► Line
Line + SimParams ──► solver.ts  QSS zarfı (K1 yük transferi, K2 μ_eff elipsi, K3 3B g-bütçesi, K6 roll-rate)
                 ──► corners.ts segmentasyon (B,T,A,P,E per viraj)              [YENİ]
                 ──► events.ts  olay şablonu → v_event(s); v = min(v_event, v_QSS)  [YENİ]
                 ──► rider.ts   kanallar (tps/brake/gear/rpm/dtc) OLAYLARDAN, sezgisel yok [YENİDEN]
                 ──► toSession.ts (DEĞİŞMEZ)
derive.ts: (aggressiveness, risk) → RiderParams türetimi                        [YENİ]
```

`simulate(track, corridor, params)` imzası korunur (extension seam). `params.rider` artık iki
üst-parametre + opsiyonel override'lar taşır.

### 2.1 K1 — Araç: yük transferi ve yatış düzeltmesi (`solver.ts`, `vehicle.ts` yeni)

Yeni `MachineParams` alanları: `cgRearM` (b: arka temas → CG yatay), `tyreCrownM` (t, ~0,06-0,09),
`hangOffM` (d_r, 0-0,3; sürücü kütlesi `riderMassKg` ayrı). Denklemler (R1 §3.1-3.2):

```
h_φ        = t + (h − t)·cos φ
a_wheelie  = g·b/h_φ − F_D·h_D/(m·h_φ)            (mevcut g·L/(2h) yerine)
a_stoppie  = g·(p−b)/h_φ                           (YENİ; drag bunun ÜSTÜNE eklenir)
fren tavanı (lastik payı) = min(μx_eff·g·ellipse, a_stoppie, brakingG_türetilen·g)
φ_bike(φ_i) = φ_i + asin(t·sinφ_i / R) − atan2(e, h−t),  e = m_r·d_r/m, R = √((h−t)²+e²)
lean tavanı: φ_bike(φ_i,max) = maxLeanDeg  →  φ_i,max ters çözülür (bisection, monoton) → a_lat,max
```

Kanal `lean` artık gerçek motor yatışı `φ_bike`'tır (IMU ile karşılaştırılabilir).

### 2.2 K2 — Lastik: slip ile ölçeklenmiş elips (`tyre.ts` yeni)

```ts
gripFraction(s, C) = sin(C · atan(tan(π/(2C)) · clamp(s,0,1)))
μ_brake_eff = μx · gripFraction(s_brake, 1.6)     // ön
μ_drive_eff = μx · gripFraction(s_drive, 1.6)     // arka
μ_lat_eff   = μy · gripFraction(s_lat,   1.3)
elips: (a_x/(μ_long_eff·g̃))² + (a_y/(μ_lat_eff·g̃))² ≤ 1
```

`TyreTrackParams`: `mu` → `muX`, `muY` (varsayılan eşit; eski `mu` okunursa ikisine kopyalanır),
`gripScale` kalır. `s_*` **RiderParams**'ta (türetilen). Kontrol değerleri: g(0,5;1,6)=0,856,
g(0,6;1,6)=0,92, g(0,8;1,6)=0,985. μ_peak kalibrasyonu: s<1 geldiğinde tur süresini korumak için
preset `muY` ~1,40'a çıkar (belgelenir, W4 ölçer).

### 2.3 K3 — 3B yol altyapısı (veri yok)

`Line` → `slopeRad: Float32Array`, `bankRad: Float32Array`, `nu: Float32Array` (hepsi 0).
Çözücüde `g̃ = g·cosσ·cosβ + v²ν`, `ã_x = a_x + g·sinσ`, `ã_y = v²κ − g·cosσ·sinβ`; elips ve
lean `g̃/ã` ile. **Test:** sıfır kanallarla v1 ile bit-bit aynı zarf. DEM okuyucu **yok** (ertelendi).

### 2.4 K5 — Viraj segmentasyonu (`corners.ts` yeni, saf)

Girdi: `Line` (κ, 20 m ölçek) + QSS zarfı `v_qss`. Çıktı: `Corner[]`.

```
Corner { iB, iT, iA, iAgeo, iP, iE, dir: ±1, hasBrake: boolean, flips: number[] }
1. adaylar = yerel minimumlar(v_qss); prominence < max(8 km/h, 5 %·v) olanlar atılır
2. birleştirme: ardışık iki minimum arasında toparlanma < prominence eşiği VEYA tam gaz için yer yok
   (mesafe < v²/(2·a_drive)) → TEK viraj (şikan: içerde işaret değişimleri = flips)
3. her viraj: A = argmin v_qss; A_geo = argmax |κ|; T = A'dan geriye |κ| < 0,25·|κ|max ilk nokta;
   E = A'dan ileriye aynı eşik VEYA sonraki B; P = A + t_pick (≥ A − 0,3 s); B = olay şablonundan (2.5)
4. hasBrake = v_entry > v_A + eşik; değilse viraj frensiz (yalnız gaz kesme)
Kabul: Serres'te viraj sayısı 7-14; her virajda tek B ve tek P.
```

Eşikler (`k_frac` 0,25, prominence 8 km/h / %5) `corners.ts`'te sabit, kaynak yorumuyla (R3 §3,
"öneri" etiketli; W4 kalibre eder).

### 2.5 K5/K6/K8 — Olay şablonu ve hız profili (`events.ts` yeni)

Her viraj için A'dan **geriye** ve **ileriye** analitik parçalar; sonuç `v_event(s)`,
`v = min(v_event, v_qss)` (QSS zarfı üst sınır: elips, stoppie, wheelie, güç, roll-rate).

Geriye (fren):
```
build:    a_tyre(t) = min(J_b·t, g_b)        J_b = brakeRiseGps (A'dan), g_b = μ_brake_eff·g (R'den)
plato:    a_tyre = g_b                       ön fren + drag (drag jerk'siz)
release:  T'den A'ya, lean φ artarken a_tyre = g_b·brakeShare(latUse, depth, profile)  (mevcut fonksiyon, R'den türetilen depth/profile)
B = bu profilin önceki virajın sürüş eğrisini kestiği nokta (geriye entegrasyon, 1D)
```
İleriye (gaz):
```
bakım gazı: A → P, a_x ≈ 0 (drag karşılanır), süre t_pick(A)
roll-on:   P'den tps 20→90 % t_roll_on(A) içinde; a_x = min(güç, μ_drive_eff·elips·TC, wheelie)·ramp
tam gaz:   bir sonraki B'ye kadar KESİLMEZ (kısıt 1)
```
Roll-rate (K6): `φ̇_max(V,φ) = (0,5+0,5·A)·(β0+β1·V)/g·cos²φ`, β0 = 23,5 m/s³, β1 = −0,31 s⁻²
(Biniewicz tez; makale 32,56 — W3 teyit eder). Kısıt `v ≤ φ̇_max/|dφ/ds|` zarfa eklenir, 2-3 iterasyon.
Turn-in süresi `φ_A/φ̇̄` olay şablonuna geçiş bölgesi olarak girer.

### 2.6 K7 — Üst-parametreler ve türetim (`derive.ts` yeni)

`RiderParams` v2:
```ts
{ aggressiveness: number; risk: number;      // 0..1, slider
  overrides?: Partial<DerivedRider>;         // gelişmiş panel
  lineDeviationM; kappa }                    // değişmez
DerivedRider = { sBrake, sDrive, sLat, brakeRiseGps, throttleDelayS (t_pick), rollOnS,
                 rollRateFrac, trailBrakeDepth, trailBrakeProfile, leanUsage, tcThreshold }
```
Başlangıç eşlemesi (R3 §5 + R2 §3.5; **tümü "öneri", W4 Ducati verisiyle kalibre eder**):
```
sBrake = 0,30 + 0,65·R      sDrive = 0,50 + 0,45·R      sLat = 0,55 + 0,42·R
trailBrakeDepth = 0,3 + 0,6·R    trailBrakeProfile = R    leanUsage → φ_use = φ_max·g(sLat,1.3)
brakeRiseGps = (0,6 + 0,4·A)·2,8 g/s    throttleDelayS = 1,6 − 1,4·A    rollOnS = 1,2 − 0,8·A
rollRateFrac = 0,5 + 0,5·A
```
Ayrışma: **A zamanlama/geçiş**, **R kuvvet seviyesi**. Eski sliderlar override olarak kalır;
preset `kappa` ve makine değerleri değişmez. Katsayılar `presets.ts`'te tek tabloda.

### 2.7 rider.ts yeniden

Kanallar olaylardan üretilir: `brake` = fren şablonu (build/plato/release), `tps` = bakım gazı +
roll-on + tam gaz, `gear/rpm` mevcut model, `dtc` mevcut. **Silinir:** `DEMAND_TAU_S`, `BRAKE_ON/OFF_PCT`,
`MERGE_GAP_S`, `SAME_CORNER_*`, `MIN_EVENT_S`, rate-limit sabitleri (`BRAKE_ON_PCT_S` 700 → ölçülen
build 0,37-0,40 s zaten şablonda).

### 2.8 K9 — Risk banner

`gripUse` μ_eff ile normalize; `GRIP_WARN` anlamı "sürücünün kendi tavanı aşıldı". İkinci değer
`gripUsePeak` (μ_peak'e göre) kanal olarak eklenir; UI ikisini gösterir.

### 2.10 Çözücü modu — kullanıcı sapma onayı (2026-10-11)

Kullanıcı kararı: "Do both and make it a choice I can click to switch between." Üç mod, tek anahtar:

| Mod | Ne | Nerede / süre | Sürücü | Çıktı |
|---|---|---|---|---|
| **Sürücü** (varsayılan) | 2.1-2.8 viraj-olay QSS | tarayıcı ana iş parçacığı, < 50 ms, slider canlı | A/R ile insan sürücü; kısıt 1-3 geçerli | `Session` (sim) |
| **Serbest yörünge** | Free-trajectory QSS: çizgi ve hız birlikte optimize (Veneri & Massaro 2020 yaklaşımı). Uygulama: koridor içinde çizgi ofsetleri karar değişkeni; iç döngü mevcut QSS zarfı (s=1, jerk/roll-rate yok); dış döngü gradyansız/ADAM benzeri optimizasyon veya TUM min-curvature QP + FBGA hız profili (algoritma referansı, LGPL kodu taşınmaz) | **Web Worker**, saniyeler; ilerleme çubuğu; sonuç `(trackKey, machine, tyre)` anahtarıyla önbellek | ideal (tavan) | `Session` (sim-opt) |
| **Tam OCP** | Transient minimum-time optimal kontrol (tek-iz + roll; CasADi direct collocation + IPOPT, `ocp/`) | **Kullanıcının YEREL köprüsü** (127.0.0.1:8777, masaüstü DDA Lab uygulaması; kullanıcı kararı 2026-10-11: sunucu yalnız uygulamayı servis eder, çözüm her kullanıcının kendi bilgisayarında koşar); `POST /ocp/jobs` (token yok), `GET /ocp/jobs/{id}`; Serres'te ~2 s | ideal (fizik tavanı) | `Session` (sim-ocp) |

Kurallar:
- Üç mod aynı `Line`/`Corridor`/`SimParams`'ı okur; yalnız `simulate()` arkasındaki çözücü değişir
  (`SolverMode = 'rider' | 'freeTrajectory' | 'ocp'`, `simulate(track, corridor, params, mode)`).
- Her mod ayrı sim session üretir (`sim`, `sim-opt`, `sim-ocp`); üçü **aynı anda** yüklü kalabilir →
  Δt karşılaştırması: "sürücü vs ideal çizgi vs fizik tavanı" **koçluk görünümü**.
- Optimal modlarda A/R sliderları devre dışı (gri, açıklama: "ideal sürücü"); makine/lastik sliderları
  aktif; hesap yeniden tetiklenir ancak **buton ile** ("Hesapla"), slider sürüklemesinde değil.
- Tam OCP sunucuya HİÇ kurulmaz (`deploy_lab.sh` ocp/ yüklemez; sunucudaki `/ocp/jobs` 503 döner).
  Masaüstü build (`DDA Lab.spec`) ocp/ + CasADi'yi paketler; yerel köprü yoksa mod gri, açıklama ile.
- Serbest yörünge çizgisi `idealLine` katmanına ikinci renkte çizilir; OCP çizgisi üçüncü.

Bu bölüm model-selection K4/K5'in "ertelendi" kararını **kullanıcı talebiyle** geri alır; sürücü modu
hâlâ varsayılan ve kısıtların uygulandığı yerdir.

### 2.9 UI (`SimPanel.tsx`)

Panel başında **çözücü modu anahtarı** (üç seçenek, 2.10) ve optimal modlar için "Hesapla" butonu +
ilerleme/durum satırı.

Sürücü grubu: **Agresiflik** ve **Risk** iki büyük slider + "Gelişmiş" açılır bölümde türetilen
değerler (okunur, override edilebilir, "türetildi/override" rozeti). Makine grubu: `cgRearM`,
`tyreCrownM`, `hangOffM` eklenir. Başlıkta tur süresi + **viraj/fren sayısı**. Harita katmanı:
viraj olayları (B/T/A/P/E işaretleri) opsiyonel.

---

## 3. Parametre tablosu v2

| Grup | Parametre | Kaynak | Yeni? |
|---|---|---|---|
| Makine | powerKw, massKg, riderMassKg, cdA, wheelbaseM, cgHeightM, **cgRearM**, **tyreCrownM**, **hangOffM**, finalDrive, gearRatios | preset | 4 yeni |
| Lastik/pist | **muX**, **muY**, gripScale, maxLeanDeg, kerbMarginM | preset | mu bölündü |
| Sürücü | **aggressiveness**, **risk**, lineDeviationM, kappa, overrides | slider | 2 yeni üst |
| Türetilen | sBrake, sDrive, sLat, brakeRiseGps, throttleDelayS, rollOnS, rollRateFrac, trailBrakeDepth, trailBrakeProfile, leanUsage, tcThreshold | derive.ts | |

---

## 4. Doğrulama ve kabul (K10)

Doğrulama koşumu `scripts/sim-validate.ts` + `tests/unit/simSerres.test.ts`:

**(a) Sahibin Ducati Run036 (1:35.8, gerçek GPS, lean, tps, wheel_slip, DTC)** — R3 §6.3 tarifi:
1. `wheel_slip_pct` lean düzeltmesi (R2 §3.6: sürüşsüz örneklerde `slip_0 = c0 + c2(1−cosφ)` regresyonu).
2. Ölçülen metrikler: fren g tepe/tipik, build hızı, roll-rate p90, t_pick, roll-on, slip p95/DTC eşiği, lean p99.
3. Her metrik → A veya R tahmini (2.6 formüllerinin tersi); ağırlıklı medyan; tutarsızlıklar raporlanır.
4. Fit edilmiş (A,R) + Panigale preseti ile sim ≈ 1:35.8 (±1 s).

**(b) BMW 1:19.81 / R6 1:19.849 (yalnız hız; R6 +gaz+vites)** — viraj metrikleri:

| Metrik | Hedef | v1 |
|---|---|---|
| tur süresi hatası | ≤ 0,5 s | 0,66 s |
| fren olayı sayısı | 7-14 | 16 |
| köşe min-hız RMSE | ≤ 5 km/h (geometri açığı saklı kalır, raporlanır) | 11-15 (3 köşe) |
| fren build süresi | 0,3-0,5 s | 0,02-0,07 s |
| long_g p25 | −0,70 ± 0,10 g | −0,95 |
| R6 t_pick, roll-on | ölçülenle ±0,3 s | — |

**(c) Birim testler:** `simTyre` (g(s) monotonluk, kontrol değerleri), `simVehicle` (stoppie/wheelie,
lean ters çözüm), `simCorners` (sentetik 5-viraj devre: sayı, tek B/P, şikan birleşmesi), `simEvents`
(tek fren/tek gaz, v ≤ v_qss, A↑ → tur↓, R↑ → tur↓ monoton), `simSolver` (3B sıfır kanal = v1 bit-bit),
`simDerive` (override öncelik). Mevcut 456 test geçmeye devam eder (değişen davranış için güncellenir).

**(d) Görsel:** dev server + Playwright, A/R slider → harita/grafik güncellenir (proje kuralı).

---

## 5. Ertelenen / reddedilen

| Madde | Karar | Gerekçe |
|---|---|---|
| DEM eğim (Terrarium) | ertelendi, opsiyon | Serres rölyef 8 m, gürültü düzeyinde; ≤ 0,3 s |
| Banking | reddedildi | açık DEM veremez |
| Tam Magic Formula / MF-Swift | reddedildi | 40+ parametre, gözlenemez |
| Termal/basınç, relaxation | reddedildi | QSS'te anlamsız |
| FBGA portu | serbest-yörünge modunun hız profili için **aday** (MIT) | 2.10 |
| Free-trajectory / OCP | **ALINDI** (kullanıcı kararı), ayrı modlar | 2.10 |
| Sharp/FastBike/stabilite | reddedildi | tur süresine etkisiz |
| Kamber-kayma ayrımı | görselleştirme LUT | slip açısı gözlenmiyor |
| R3 "bölge-bölge fren" sezgiseli | reddedildi | stoppie+drag fizikten üretir |

## 6. Riskler

1. A/R → s katsayıları kalibre değil; ilk Ducati fit'i sonucu değiştirebilir (katsayılar tek tabloda).
2. μ_peak yeniden kalibrasyonu (~1,40) tur süresi eşleşmesini geçici bozar; W4 ölçer.
3. Biniewicz β0 belirsizliği (23,5 vs 32,6) roll-rate'i ±%30 oynatır.
4. Hızlı referanslarda lean yok → roll-rate/lean yalnız Ducati'den doğrulanır.
5. Olay şablonu + QSS min'i geçiş noktalarında süreksizlik üretebilir → `v_event` C¹ olmalı (jerk sınırı bunu sağlar), test edilir.

## 7. Değişiklik günlüğü (v1 → v2)

- Sürücü: per-sample lag katmanı → viraj-olay modeli; sezgisel birleştirme kaldırıldı.
- Üst-parametreler aggressiveness/risk; eski sliderlar türetilen + override.
- Lastik: μ → μx/μy × g(s); üç izin verilen slip.
- Araç: cgRearM, tyreCrownM, hangOffM; stoppie limiti; gerçek wheelie; lean = φ_bike.
- Yol: 3B g-bütçesi altyapısı, veri yok.
- Risk banner μ_eff'e normalize.
- Doğrulama: Ducati Run036 birincil; viraj metrikleri kabul kriteri.
- Çözücü modu anahtarı: Sürücü / Serbest yörünge (worker) / Tam OCP (sunucu) — kullanıcı sapma onayı.
