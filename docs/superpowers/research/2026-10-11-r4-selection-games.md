# R4 — Model seçimi ve oyun motorlarında motosiklet/sürücü modeli

**Tarih:** 2026-10-11 · **Kapsam:** sahibin 6. ve 7. maddeleri ("motosiklet sürücü modelleri için en iyi model seçimi", "oyun motorları motosiklet sürücüsünü nasıl modelliyor") + koordinatörün eklediği **açık kaynak envanteri**.
**Bağlayıcı kısıtlar:** (1) her virajda tek fren + tek gaz geçişi, olay-güdümlü viraj; (2) lastik peak-slip altında, "izin verilen slip" (allowed slip) bir sürücü parametresi; (3) agresiflik/risk → roll rate ve allowed slip.
**Mevcut durum (notlar §4–5):** QSS 3-pass, tarayıcıda 1:20.47 / gerçek 1:19.81 (+0,8 %); fren uygulama sayısı gerçeğin ~2 katı; geçiş şekilleri step (0,02–0,07 s), gerçek 0,2–3,3 s.

---

## 1. Özet

1. **Önerilen seviye: "Corner-event QSS + rate-limited rider" (Seviye 2).** Yol sabit (mevcut κ-çizgisi). Hız zarfı FBGA tipi genel bir g-g-v zarfıyla çıkarılır. Bunun üstüne viraj başına 5 olaylık bir program kurulur (brake point → turn-in → apex → throttle point → exit). Olaylar arası geçişler **jerk ve roll-rate sınırlı** yapılır, tutunma da allowed slip'e göre ölçeklenir.
2. Literatür bu seviyenin doğruluğunu destekliyor. QSS/OCP motosiklet modelleri gerçek turlara **~0,9 %** yaklaşıyor: Biniewicz'in R6 modeli Road Atlanta'da 89,66 s, gerçek tur 90,49 s; Dal Bianco ve ark. TT Zero'da 29:31, gerçek 29:47. FBGA ise OCP'den yalnızca **0,11–0,36 %** sapıyor ve bir turu **2–11 ms**'de çözüyor (motosiklet modeli dahil). DDA Lab'ın +0,8 %'lük sonucu zaten bu bantta. Ek fizik doğruluk kazandırmaz, kazandıracak şey **olay yapısı ve geçiş şekli**.
3. Üç kısıt da bu seviyede doğrudan karşılanıyor. Tek fren/tek gaz bir olay programı ile, allowed slip bir tutunma-kullanım fonksiyonu u(σ) ile, roll rate ve jerk de Biniewicz'in deneysel jerk sınırlarına benzer kısıtlarla.
4. **Transient OCP** (Leonelli & Limebeer, Fastest-lap, Canopy) tur başına dakikalar sürüyor ve bir NLP çözücü (Ipopt) gerektiriyor. 50 ms bütçesine 3–4 mertebe uzak, ayrıca "ideal sürücü" üretir. Kısıt 1–3 ise ideal olmayan bir sürücü istiyor.
5. **Free-trajectory QSS** (Veneri & Massaro) sabit yollu QSS'ten **~10× yavaş** ve yine bir OCP. Çizgi zaten κ ile parametreli olduğu için kazancı düşük.
6. **Oyunlardan çıkan ders:** ticari oyunlar (Milestone A.N.N.A., GT Sophy) zorluğu "**nerede ve ne kadar yavaşlanacağı**" ile ayarlıyor. Sophy ödülünde ayrıca açık bir **tyre-slip penalty** var. Assetto Corsa AI'ı viraj başına "algılanan yarıçap" ve "fren sertliği" çarpanlarıyla çalışıyor. Bunlar kısıt 2–3'ün oyun dünyasındaki karşılığı.
7. Hiçbir motosiklet oyunu (GP Bikes, MX Bikes, MotoGP, RiMS, TT) fizik/AI iç yapısını belgelemiyor. Tasarım kararı için birincil kaynak olamazlar, yalnızca kavram kaynağı olabilirler.
8. **Yedek plan (fallback):** mevcut 3-pass QSS korunur. Üstüne olay birleştirme (notlar §5.3) ve geçişlere post-hoc jerk/roll-rate yumuşatma eklenir (Seviye 1+). Lap-time sadakati korunur, kısıt 1 sağlanır, kısıt 2–3 ise yalnızca kısmen sağlanır.
9. Açık kaynaktan doğrudan taşınabilecek en değerli parça **DRIVEWISE/FBGA** (MIT, C++, 2026, motosiklet örnekli). Ayrıca TUM `trajectory_planning_helpers` içindeki `calc_vel_profile` (LGPL-3.0, algoritma referansı) ve TUM `racetrack-database` (test verisi) işe yarar.
10. Bu seviyenin gözlemlenebilirliği yüksek: roll rate, jerk ve allowed slip'in her biri telemetriden (lean, long_g, speed) viraj başına doğrudan ölçülebiliyor (§6).

---

## 2. Yöntem karşılaştırması (A)

| Yöntem | Temsilci kaynak | Gerçek tura / referansa doğruluk (yayınlanmış) | Hesap maliyeti | Neyi üretir / üretemez | Parametre sayısı |
|---|---|---|---|---|---|
| **Steady-state / segment** | Siegler, Deakin & Crolla 2000 (SAE 2000-01-3563) | Karşılaştırmalı çalışma; QSS'in transient'e göre yaw damping vb. ihmal ettiğini gösterir (sayısal fark kaynağa erişilemedi) | µs–ms | Viraj min hızı. Geçiş, fren noktası şekli ve çizgi üretemez | 5–10 |
| **QSS sabit yol, point-mass / g-g(-v)** (forward-backward) | OpenLAP, TUM laptimesim (Heilmeier 2019), DDA Lab bugünkü hali, Kozlenok | DDA Lab: +0,8 %. Kozlenok: eğrilik doğrulaması medyan bias <0,7 % (üç pist). Casanova'nın dinamik ve QSS yöntemleri arasında 2,3 s fark (Massaro & Limebeer 2021 incelemesinde aktarılmış) | O(n), ~1 ms (JS'de birkaç ms) | Hız zarfı, fren noktası (≈), apex. **Geçiş şekli yok** (step), çizgi sabit, fren olayları gürültüyle bölünür | 8–15 |
| **QSS + jerk/insan sınırlı OCP** | Biniewicz & Pyrz 2023 (VSD 62(2)); Biniewicz doktora tezi | **R6 / Road Atlanta: 89,658 s sim vs 90,485 s gerçek (−0,9 %)**; PitBike/Toruń 60,50 vs 61,32 s | 2D'de ~308 s / tur; 3D'de >10× | Jerk sınırlı (insan) fren/gaz ve yanal geçişler, deneysel g-g. OCP gerektirir | 15–25 (β0, β1 jerk katsayıları dahil) |
| **Generic g-g-v forward-backward (FBGA)** | Piazza, Piccinini, Taddei, Biral, Bertolazzi 2026 (IEEE RA-L) | OCP referansına **0,11–0,36 %** (5 pist, otomobil + motosiklet) | **2,4–11,4 ms / tur** (M2 Max, C++). 300 m ufuk 0,18 ms | Konveks olmayan g-g-v zarfında optimal hız profili. Jerk kısıtı **yok** ("gelecek çalışma") | Zarf tablosu + 5–10 |
| **Free-trajectory QSS (OCP)** | Veneri & Massaro 2019/2020 (VSD); Lovato & Massaro 2021 (3D) | Free-traj OCP ile fixed-traj OCP arası **0,02 %** (motosiklet). Motosiklet referans turu 72,519 s (gerçek tur karşılaştırması yok) | Dinamik free-traj'dan **~10× hızlı**, sabit-yol QSS'ten **~10× yavaş** (Lovato & Massaro, incelemede aktarılmış) | Optimal çizgi + hız. Geçiş dinamiği yok | g-g haritası + ~12 (m=250 kg, h=0,69 m, μx=1,2, μy=1,44 ...) |
| **Transient minimum-time OCP** | Massaro & Limebeer 2021 incelemesi; Leonelli & Limebeer 2020 (VSD 58(8)); Dal Bianco, Lot & Matthys 2018; Kelly 2008 (Cranfield tezi) | **TT Zero: 29:31 sim vs 29:47 gerçek (≈0,9 %)**. Kart: 53,6 s ≈ 53,6 s (Lot & Dal Bianco 2016). 3D etkisi Mugello motosikletinde ~4 s | Dakikalar–1 saat (Perantoni & Limebeer 15 dk–1 sa; kart 230 s; TT <3 dk; Christ ve ark. 100–120 s) | Optimal çizgi + tüm girdiler (steer, gaz, fren), roll/pitch dinamiği. **İdeal sürücü**, kontrollü slip için ek kısıt gerekir | 30–100+ (12 durum, 2 girdi TT modelinde) |
| **Forward / driver-model simülasyonu** | Brayshaw & Harrison 2005 (7-DOF QSS hibrit); Lot, Massaro & Sartori 2008 "Advanced Motorcycle Virtual Rider" (OMM referansı + hıza bağlı PID); Völkl ve ark. 2013 (QSS + transient iterasyon) | Virtual rider Mugello'da test edilmiş (sayısal hata bulunamadı, doğrulanmadı) | Gerçek zamanlı veya daha hızlı, ama sürücü kontrolcüsü ayarı gerekir | Gerçekçi geçiş şekilleri, kontrolcü kusurları. Çizgi/hız referansı başka yöntemden gelir | 20–50 (kontrolcü kazançları dahil) |

**Çıkarım:** doğrulukta yöntemler arası fark (~0,1–1 %) DDA Lab'ın geometri belirsizliğinden (μ ±0,1 ≈ ±2,5 s, notlar §5.2) çok daha küçük. Seçimi doğruluk değil **kısıtlar ve bütçe** belirliyor.

---

## 3. Araçlar (B)

### 3a. Ticari / kapalı araçlar

| Araç | Model seviyesi | Sürücü yaklaşımı | Viraj segmentasyonu | Bildirilen hata | Kaynak kalitesi |
|---|---|---|---|---|---|
| OptimumLap (OptimumG) | QSS point-mass | Yok (ideal) | Segment / pist dosyası | FSAE Michigan 2014 sonuçlarıyla karşılaştırılmış (SAE 2016-36-0164). Sayı erişilemedi | endüstri / akademik kullanım |
| ChassisSim | Transient force-based (iddia) | doğrulanmadı | doğrulanmadı | doğrulanmadı | doğrulanmadı |
| Canopy Simulations (Michelin, 2023'ten beri) | Collocation tabanlı optimal kontrol | İdeal (OCP) | Sürekli | F1/FE tedarikçisi beyanı, sayı yok | endüstri (pazarlama) |
| Pi/Cosworth Lap Time Simulation | doğrulanmadı | doğrulanmadı | — | — | doğrulanmadı |
| VI-grade (VI-CarRealTime / VI-BikeRealTime) | Gerçek zamanlı çok-DOF + yol takip sürücüsü (doğrulanmadı) | Path-follow + speed profile (doğrulanmadı) | — | — | doğrulanmadı |
| BikeSim (Mechanical Simulation) | Multibody motosiklet | Sürücü kontrolcüsü | — | — | endüstri |
| Dynamotion OMS | Motosiklet minimum-time OMS (Padova "optimal maneuver" ailesi) | İdeal | — | — | endüstri |
| Kozlenok moto LTS (kişisel, kapalı) | QSS, 3 iterasyonlu forward/backward, combined slip, wheelie/stoppie | **Makine ve sürücü sınırları ayrı** (peak decel, peak lean). Ölçülen roll rate p90 34 °/s, peak 99 °/s | AiM GPS'ten 1 m eğrilik | Eğrilik vs ölçülen lat-g: medyan bias <0,7 % | geliştirici blogu |

### 3b. Açık kaynak envanteri (koordinatör eki)

Lisans ve son aktivite 2026-10-11'de GitHub API'den alındı. "Yeniden kullanım" sütunu tarayıcıda çalışacak TypeScript QSS corner-event simülatörü açısından yazıldı. GPL ve LGPL kodu **taşınmamalı**, yalnızca algoritma referansı olarak okunmalı. MIT, BSD ve Apache kodu atıfla taşınabilir.

**Lap-time / hız profili**

| Proje | URL | Lisans | Dil | Son aktivite | Model seviyesi | DDA Lab için yeniden kullanılabilir |
|---|---|---|---|---|---|---|
| **DRIVEWISE/FBGA** | github.com/DRIVEWISE/FBGA | **MIT** | C++ | 2026 | Generic g-g-v forward-backward, otomobil + **motosiklet** | **En değerli parça.** Konveks olmayan zarfta forward/backward geçişi, signed-distance zarf testi ve kök bulma TS'e taşınabilir. Jerk yok, onu biz ekleriz |
| TUMFTM/laptime-simulation | github.com/TUMFTM/laptime-simulation | LGPL-3.0 | Python | 2026 | QSS, vites, ERS | Vites/rpm modeli ve QSS iterasyon yapısı (referans) |
| TUMFTM/global_racetrajectory_optimization | github.com/TUMFTM/global_racetrajectory_optimization | LGPL-3.0 | Python | 2023 | Min-curvature QP + min-time, ggv tabanlı hız profili | Min-curvature QP fikri (κ-çizgisine alternatif). ggv dosya formatı |
| TUMFTM/trajectory_planning_helpers | github.com/TUMFTM/trajectory_planning_helpers | LGPL-3.0 | Python | 2024 | `calc_vel_profile` (forward/backward), `calc_vel_profile_brake` | Algoritma referansı, test kıyası |
| TUMFTM/racetrack-database | github.com/TUMFTM/racetrack-database | LGPL-3.0 | veri | 2021 | 20+ pist: merkez çizgi, genişlik, yarış çizgisi | **Test fixture** (corridor + raceline doğrulaması) |
| TUM-AVS/GGGVDiagrams | github.com/TUM-AVS/GGGVDiagrams | GPL-3.0 | C++ | 2025 | g-g ve g-g-g-v diyagramı üretimi | Motosiklet g-g-v zarfını çevrimdışı üretip tablo olarak gömme (kod değil, çıktı) |
| mc12027/OpenLAP-Lap-Time-Simulator | github.com/mc12027/OpenLAP-Lap-Time-Simulator | GPL-3.0 | MATLAB | 2022 | Mesafe tabanlı point-mass QSS (OpenVEHICLE/OpenTRACK) | Pistin loglanmış veriden üretilmesi (referans) |
| dstrassera/OpenLapSim | github.com/dstrassera/openlapsim | GPL-3.0 | Python | 2023 | Steady-state LTS | Düşük |
| juanmanzanero/fastest-lap | github.com/juanmanzanero/fastest-lap | MIT | C++/Python | 2023 | **Transient OCP** (Ipopt + CppAD, Catalunya ~1 dk), sayısal g-g | Çevrimdışı "ideal lap" referansı üretmek. Tarayıcıda değil |
| CommonRoad/commonroad-raceline-planner | github.com/CommonRoad/commonroad-raceline-planner | BSD-3 | Python | 2025 | Raceline planlama araç kutusu | Çizgi üretimi referansı |
| jonblissett/bike-sim | github.com/jonblissett/bike-sim | GPL-3.0 | Python | 2018 | Elektrikli motosiklet LTS (TT Zero) | Düşük (referans) |
| MikeAlvarado/getapex | github.com/MikeAlvarado/getapex | lisans yok | TypeScript | 2026 | Tarayıcıda raceline + apex + fren noktası (otomobil) | Lisanssız, **kod alınamaz**. UI fikri olarak bakılabilir |
| amz-racing/fssim | github.com/amz-racing/fssim | doğrulanmadı | C++/ROS | — | FS driverless simülatör, "gotthard lap time %1" | Düşük |

**Motosiklet / bisiklet dinamiği kütüphaneleri**

| Proje | URL | Lisans | Dil | Son aktivite | Model | Yeniden kullanım |
|---|---|---|---|---|---|---|
| TUMFTM/motorcycle_model | github.com/TUMFTM/motorcycle_model | LGPL-3.0 | MATLAB (MBSim) | 2025 | Multibody motosiklet | Parametre setleri, roll/steer doğrulaması (çevrimdışı) |
| moorepants/BicycleParameters | github.com/moorepants/BicycleParameters | özel (NOASSERTION) | Python | 2026 | Whipple/Carvallo parametreleri, sürücü ataleti | Sürücü + makine atalet tahmini (cg yüksekliği vb.) |
| moorepants/yeadon | github.com/moorepants/yeadon | özel (NOASSERTION) | Python | 2026 | Yeadon insan atalet modeli | Sürücü kütle dağılımı (düşük öncelik) |
| modelica-3rdparty/MotorcycleDynamics | github.com/modelica-3rdparty/MotorcycleDynamics | belirtilmemiş | Modelica | 2013 | Aktif kontrol testi için motosiklet | Düşük |
| projectchrono/chrono | github.com/projectchrono/chrono | BSD-3 | C++ | 2026 | Multibody, araç modülü | Düşük (tarayıcı dışı) |
| google-deepmind/mujoco | github.com/google-deepmind/mujoco | Apache-2.0 | C++ (WASM var) | 2026 | Genel rigid-body | Motosiklet demo'su bulunamadı. Düşük |
| dikshant1103-beep/moto-sim | github.com/dikshant1103-beep/moto-sim | MIT | Python (PyChrono) | 2026 | Multibody + tire PINN, Whipple benchmark | Whipple benchmark testleri (fikir) |
| TUMFTM/open-car-dynamics | github.com/tumftm/open-car-dynamics | Apache-2.0 | C++ | 2026 | Otomobil multibody | Düşük |
| JBike6 (MATLAB, Schwab/Papadopoulos) | — | doğrulanmadı | MATLAB | doğrulanmadı | Whipple doğrusal kararlılık | doğrulanmadı |

**Telemetri / viraj analizi**

| Proje | URL | Lisans | Dil | Son aktivite | Ne yapıyor | Yeniden kullanım |
|---|---|---|---|---|---|---|
| speedhq/raceiq | github.com/speedhq/raceiq | AGPL-3.0 | **TypeScript** | 2026 | Sim-racing telemetri, tur ve viraj analizi | Viraj tespiti/UI fikirleri. AGPL nedeniyle kod alınmamalı |
| caezium/stint | github.com/caezium/stint | lisans yok | TypeScript + FastAPI | 2026 | AiM .xrk/.xrz: tur, split, **viraj**, G-G | Kod alınamaz. AiM format bilgisi referansı |
| xiaofengzky/kart-telemetry | github.com/xiaofengzky/kart-telemetry | lisans yok | JavaScript | 2026 | .vbo, uydu haritası, viraj analizi | Fikir |
| moebiusx/gt7-telemetry-analyzer | github.com/moebiusx/gt7-telemetry-analyzer | doğrulanmadı | Python | 2026 | Micro-sector cause/loss haritası, trail-brake penceresi tespiti | "Cause vs loss" (kaybın başladığı nokta vs tepe noktası) fikri |
| timurrrr/RaceChronoDiyBleDevice | github.com/timurrrr/RaceChronoDiyBleDevice | MIT | C++ | 2025 | RaceChrono'ya CAN verisi | Notlar §5.4'teki "gerçek brake/TPS logu" eksiği için donanım yolu |
| MoTeC .ld okuyucuları (c1212-ld-reader, i3pro) | github.com/CorcelAzulMeioVerde/c1212-ld-reader | MIT / GPL-3.0 | Python | 2026 | .ld ayrıştırma | Gelecekte MoTeC logu içe aktarma |
| Telemetry Overlay | — | ticari | — | — | Video + telemetri | Açık kaynak değil |
| pyRaceTelemetry | — | **bulunamadı** | — | — | — | — |

**Açık yarış oyunu fiziği**

| Proje | URL | Lisans | Ne sunuyor | Yeniden kullanım |
|---|---|---|---|---|
| TORCS | github.com/jeremybennett/torcs (SourceForge yansıması) | GPL-2.0 | simuv2, 500 Hz (2 ms adım). Robot API ve robot eğitimi | `GetAllowedSpeed = √(μ g r_eff)`, brakedist look-ahead mantığı (§5) |
| Speed Dreams | speed-dreams.net / SourceForge | GPL | TORCS çatalı, Simplix vb. robotlar | Robotların viraj/fren mantığı (referans) |
| BeamNG Hirochi Outlaw (mod) | beamng.com/resources/hirochi-outlaw.33927 | mod lisansı (açık kaynak değil) | **Steering PID** denge kontrolcüsü, "max lean angle" ayarı, "rider tuck" ekseni | "Hedef lean'e PID" yaklaşımı. Yazar sürücü modelini "janky" diyor |
| GP Bikes mods wiki | gpbikes-mods.fandom.com | topluluk | Config/engine/geometry sayfaları, tyre sayfası WIP | Düşük |

---

## 4. Oyun motorları (C)

**Genel bulgu:** hiçbir ticari motosiklet oyunu fizik denklemlerini, lastik modelini veya AI'ın fren noktası mantığını yayınlamamış. PiBoSo forumu bu araştırma sırasında erişilemedi (DNS hatası), bu yüzden GP Bikes ile ilgili bilgiler arama özetinden geliyor.

| Başlık | Motor | Motosiklet modeli | Sürücü modeli | Lastik modeli | AI fren/gaz mantığı | Agresiflik / zorluk | Kaynak kalitesi |
|---|---|---|---|---|---|---|---|
| **GP Bikes** (PiBoSo) | Özel ("scratch-built") | Tam rigid-body. Mod dosyalarında geometri, motor ve süspansiyon | Sürücü bisikletten ayrı lean ekseni. Bisiklet lean'i **direct steer** (gidon torku) veya varsayılan yardımlı mod ile. "Lean Help" yardımı var, asistler kapalıyken bile aşırı lean engelleniyor (oyuncu gözlemi) | "Automotive industry-standard tyre model" (Steam). MaxTyre editörü. Denklem belgelenmemiş | Belgelenmemiş | Belgelenmemiş | Steam sayfası (endüstri) + forum (doğrulanmadı) |
| **MX Bikes** (PiBoSo) | GP Bikes ile aynı motor | Şasi esnemesi, deforme olan zemin (iddia) | Sürücü ayrı simüle ediliyor. Lean ve ön/arka ağırlık ayrı çubuklarda. Geliştirici yanıtı: lean'i "tutma" veya "bırak-dön" slider'ı | Belgelenmemiş | Belgelenmemiş | — | forum / topluluk rehberi |
| **MotoGP 19–26** (Milestone) | Unreal Engine (MotoGP 18'den beri) | Kapalı. MotoGP 18'de bisiklete "hızda daha fazla görünür ağırlık" verildi (Caletti) | **MotoGP 26 "Rider-Based Handling":** "input is now applied directly to the rider's body, so the weight shifts first, and then the bike follows" (Pezzotti, 2026). Mocap animasyon karışımı | Belgelenmemiş | **A.N.N.A. (2019):** RL ajanı, "predefined commands" değil ödüllerle çalışıyor. "braking at the right time" ödüllendiriliyor. Günde 200 bin+ yarış simüle edilmiş | **"controlling where and how much it needs to slow down"** (Caletti). Adaptive Difficulty (MotoGP 24). Neural Aids (fren/steer/gaz) | PS Blog + röportaj (geliştirici), pazarlama ağırlıklı |
| **RIDE serisi** (Milestone) | Unreal | doğrulanmadı | doğrulanmadı | doğrulanmadı | doğrulanmadı | doğrulanmadı | — |
| **RiMS Racing** (RaceWard, 2021) | doğrulanmadı | Bileşen bazlı (fren diski sıcaklığı, süspansiyon) | Belgelenmemiş | Politecnico di Milano ile, **sürüş stiline bağlı gerçek zamanlı aşınma** | Belgelenmemiş | Sürüş asistleri | dev diary (geliştirici videosu, ikincil özet) |
| **TT Isle of Man RotE 2/3** (Kylotonn → RaceWard/Nacon) | KT Engine | RotE2: fizik "ground up" yeniden yazıldı, **jiroskopik etki entegre**, speed wobble. RotE3: şasi ve lean davranışı yeniden tasarlandı | Belgelenmemiş | RotE3: dinamik aşınma planlanıyor | Belgelenmemiş | Beginner / Intermediate / Simulation. TC ve anti-wheelie zorluğa bağlı | basın + dev blog |
| **SBK serisi** (Milestone, eski) | doğrulanmadı | — | — | — | — | — | bulunamadı |
| **BeamNG.drive** (Hirochi Outlaw modu) | Soft-body (node/beam) | Soft-body motosiklet | **Steering PID** ile denge. Maks lean açısı kullanıcı ayarı. Sürücü öne/arkaya "tuck" ekseni | Soft-body lastik | AI desteği belgelenmemiş | — | mod sayfası (geliştirici) |
| **Assetto Corsa** (otomobil AI, referans) | Kunos | — | — | — | Spline (fast_lane.ai) üzerinde. **HINT_x algılanan viraj yarıçapını çarpar, BRAKEHINT_x bölgedeki fren sertliği inancını değiştirir**, DANGER_x | Aggression slider (formülü belgelenmemiş) | forum (geliştirici notu alıntısı) |
| **TORCS / Speed Dreams** (otomobil robotu, referans) | Açık (GPL) | 500 Hz simuv2 | — | — | Segment başına `allowedSpeed = √(μ g r_eff / (1 − r·CA·μ/m))`. Aynı yöndeki segmentler π/2'ye kadar birleştiriliyor (r_eff = r/√arc). Brakedist look-ahead | Robot parametre dosyaları | açık kod + eğitim |
| **Gran Turismo Sophy** (otomobil, referans) | GT Sport | — | — | GT | RL, 10 Hz. Gaz+fren **tek eksen** [−1,1]. Ödül: course progress, off-course, wall, **tyre-slip penalty**, passing bonus, çarpışma cezaları | Ceza terimleri kaldırıldıkça ajan "notably more aggressive". Etiquette = agresiflik/çekingenlik dengesi | **akademik (Nature 2022)** |

**Oyunlardan aktarılabilecek dersler:**

- Ticari oyunlar oyuncu girdisini "sürücü gövdesi → bisiklet" zinciriyle filtreliyor (MotoGP 26). PiBoSo da bisiklet lean'ini gidon torkuyla veriyor. Yani counter-steer ya fiziğin kendisi oluyor ya da bir hedef-lean kontrolcüsünün (BeamNG PID) içine gömülüyor. DDA Lab için sonuç şu: roll'u **hedef-lean'e rate-limited yaklaşım** olarak modellemek, oyunların "assist" katmanının kinematik eşdeğeri.
- Zorluk/agresiflik, hiçbir oyunda fiziği değiştirmiyor. Hep **sürücünün kullandığı zarf payı ve yavaşlama yeri/miktarı** değişiyor (A.N.N.A., AC hints, Sophy ödül ağırlıkları). Bu, kısıt 3 ile birebir örtüşüyor.

---

## 5. Oyun ve otonom yarıştan çıkan corner-event mantığı (D)

Kaynaklar: TUM min-curvature + forward-backward (Heilmeier 2020; Betz 2023 IAC yığını), FBGA, TORCS robotu, AC hints, Sophy, Lot-Massaro virtual rider (OMM referansı + PID). Uygulanabilir adımlar:

1. **Yol sabit.** Mevcut κ-çizgisi kalır (TUM/IAC da global çizgiyi önce, hızı sonra çözüyor). Çizgi ile hız ayrıştırması FBGA ve Heilmeier'de standart.
2. **Viraj kimliği (segmentasyon).** Eğriliği yumuşatılmış çizgide |κ| tepeleri apex adaylarıdır. TORCS gibi aynı yönlü ardışık eğrileri birleştir. Ayrıca iki aday arasında hız toparlanması Δv < Δv_min ise ya da düz kısım < L_min ise **tek viraj** say. Böylece notlar §5.3'teki "2× fren" sorunu yapısal olarak kapanır.
3. **Apex hızı.** `v_apex = √(a_lat,use · r_eff)`, burada `a_lat,use = min(μ·g·u(σ), g·tan φ_cap)`. u(σ), allowed slip σ'nın (peak slip'e oran) normalize Magic-Formula benzeri sürtünme kullanımıdır (σ=1 → u=1, σ=0,8 → u≈0,95–0,97, kesin eğri R-başka raporundan gelmeli). AC'deki HINT_x'in karşılığı, sürücü başına bir r_eff çarpanı.
4. **Fren noktası (tek olay).** Apex'ten geriye, kullanılabilir zarf `u(σ)·g-g-v` ile FBGA backward pass yapılır. Fren başlangıcı **J_x,on** jerk rampasıyla, trail-brake bırakışı ise lean arttıkça **J_x,off** ile modellenir. Geriye entegrasyonda fren profili şu şekildedir: rampa ↑, plato, sonra apex'e doğru lean ile kombine zarfın izin verdiği kadar azalma. Fren noktası, bu profilin giriş hızına eriştiği ilk nokta. Gerekirse tek boyutlu bisection ile bulunur (viraj başına ~10 iterasyon × ~300 nokta).
5. **Turn-in noktası.** Lean `φ(s) = atan(v²κ/g)` (lastik genişliği düzeltmesi opsiyonel). Kısıt `|dφ/dt| = |dφ/ds|·v ≤ φ̇_max`. Turn-in, apex lean'ine φ̇_max ile ulaşılacak en geç nokta. Eğer çizginin eğrilik rampası bunu ihlal ediyorsa yerel hız düşürülür (ek QSS limiti `v ≤ φ̇_max/|dφ/ds|`, 1–2 sabit nokta iterasyonu).
6. **Throttle noktası (tek olay).** Apex'ten sonra, φ̇_max ile kalkarken kombine zarfın a_x > 0'a izin verdiği ilk nokta. Gaz **J_x,on,thr** rampasıyla açılır, bir sonraki virajın fren noktasına kadar **kesilmez** (kısıt 1). TC/wheelie sınırı zarfı keser ama olay sayısını değiştirmez.
7. **Exit / düzlük.** Güç, drag ve wheelie limitli forward pass (mevcut ①–③). Vites ve rpm katmanı (`rider.ts`) bu programın çıktısına uygulanır.
8. **Agresiflik eşlemesi (oyunlardan).** Tek bir "aggression" a∈[0,1] slider'ı şunları sürer: σ (allowed slip), φ̇_max, J_x (fren/gaz jerk), fren noktası emniyet payı Δs_brake (A.N.N.A.'daki "nerede ve ne kadar yavaşla" ve AC'deki BRAKEHINT karşılığı). Gelişmiş panelde bu dört parametre ayrı ayrı açılabilir. Sophy'nin tyre-slip penalty'si, σ'nın RL dünyasındaki karşılığı.
9. **Telemetri çıktısı.** Olay programı doğrudan `brake`/`tps` kanallarını üretir. Geçiş süreleri sıfır değil, jerk ve roll-rate rampası olur ve notlar §5.4'teki gerçek 0,2–3,3 s ile kıyaslanabilir hale gelir.
10. **Doğrulama metrikleri (viraj başına).** Min hız, apex konumu, fren noktası, **fren olayı sayısı (hedef: 7 işaretli virajla uyum)**, fren rampası süresi, maks roll rate. Bunlar gerçek R6 ve S1000RR turlarından okunur.

**Hesap bütçesi:** n≈4 000 nokta (1 m). FBGA tipi geçişler O(n), C++'ta 2–11 ms. JS'de kabaca 2–5× → 5–50 ms. Viraj başına bisection 16 × 10 × 300 ≈ 50 bin adım, JS'de <5 ms. Toplam ~50 ms bütçesinin içinde, ama sınırda. Gerekirse zarf tablosu ön-hesaplanır ve slider değişiminde yalnızca etkilenen virajlar yeniden çözülür.

---

## 6. Seçim matrisi (E)

Puanlar 1–5 (5 en iyi). Ağırlıklar sahibin önceliklerine göre: kısıtlar 1–3 ×3, tarayıcı bütçesi ×2, doğruluk ×2, gözlemlenebilirlik ×2, uygulama eforu ×1.

| Aday | Doğruluk (2 gerçek tur) ×2 | Tarayıcı <50 ms ×2 | Parametre gözlemlenebilirliği ×2 | Kısıt 1–3 ×3 | Efor ×1 | **Toplam** |
|---|---|---|---|---|---|---|
| S0 — Steady-state segment | 2 | 5 | 4 | 1 | 5 | 4+10+8+3+5 = **30** |
| S1 — Mevcut QSS 3-pass (+ lag layer) | 4 (+0,8 %) | 5 | 4 | 2 (kısıt 1 yok, 2–3 dolaylı) | 5 | 8+10+8+6+5 = **37** |
| S1+ — S1 + olay birleştirme + post-hoc jerk/roll yumuşatma (**fallback**) | 4 | 5 | 4 | 3 | 4 | 8+10+8+9+4 = **39** |
| **S2 — Corner-event QSS + rate-limited rider (FBGA zarfı) — ÖNERİ** | 4 | 4 | **5** (σ←lat-g/lean doygunluğu, φ̇←lean türevi, J←long_g türevi) | **5** | 3 | 8+8+10+15+3 = **44** |
| S3 — Free-trajectory QSS OCP | 4 | 1 (NLP, saniyeler) | 3 | 2 (ideal sürücü) | 2 | 8+2+6+6+2 = **24** |
| S4 — Transient minimum-time OCP | 5 | 1 (dakikalar) | 2 (30–100 param) | 2 | 1 | 10+2+4+6+1 = **23** |
| S5 — Forward driver-model (kontrolcü + roll DOF, oyun tarzı) | 4 | 3 (zaman adımlı, ~1 kHz) | 2 (kontrolcü kazançları gözlemlenemez) | 4 | 2 | 8+6+4+12+2 = **32** |

**Notlar:**
- Doğrulukta S2 ile S1 eşit puanlandı. Lap time bandı aynı kalır, çünkü kalıntı hata geometriden geliyor (notlar §5.1–5.2). S2'nin kazancı tur süresinde değil, **viraj bazında fren olayı sayısı ve geçiş şeklinde**.
- S4, gerçeğe en yakın fiziği verir. Ancak tarayıcıda çalışmaz ve kısıt 2 ile çelişir (OCP slip'i peak'e iter, Veneri & Massaro bile κ ≤ κ_max kısıtı eklemek zorunda kalmış).
- S5 oyunlarda kullanılan yol. Ama bir stabilize edici steering kontrolcüsü gerektirir (BeamNG PID, GP Bikes Lean Help) ve kazançları telemetriden gözlemlenemez.

**Nihai öneri: S2 — Corner-event QSS + rate-limited rider.**
- Çekirdek: FBGA tipi generic g-g-v forward-backward. Algoritma MIT lisanslı C++'tan TS'e yeniden yazılır, motosiklet g-g-v zarfı tablo olarak gömülür.
- Üst katman: viraj başına 5 olay (§5 adım 2–7). Bunlara jerk sınırları (Biniewicz'in deneysel `J_y(V)=β0/V+β1`, `β0=23,5 m/s³` biçimi başlangıç değeri olarak) ve roll-rate sınırı (amatör referans p90 34 °/s, peak 99 °/s — Kozlenok) eklenir.
- Sürücü parametreleri: σ (allowed slip), φ̇_max, J_x, Δs_brake. Hepsi tek bir "aggression" slider'ından türetilebilir.

**Fallback: S1+.** Mevcut 3-pass olduğu gibi kalır. Fren olayları viraj kimliğiyle birleştirilir, brake/tps kanalları jerk ve roll-rate rampasıyla post-hoc şekillendirilir. Kısıt 1 tam, kısıt 2 μ ölçeği olarak, kısıt 3 yalnızca kanal şekli olarak sağlanır. Roll-rate hızı geri beslemez, yani tur süresine etkisi olmaz. S2'nin FBGA portu takılırsa bu sürüm 1–2 günde çıkar.

---

## 7. Kaynaklar

| # | Kaynak | Yıl | Yazar / geliştirici | DOI / URL | Etiket |
|---|---|---|---|---|---|
| 1 | Minimum-lap-time optimisation and simulation, *Vehicle System Dynamics* 59(7):1069–1113 | 2021 | M. Massaro, D.J.N. Limebeer | research.unipd.it/handle/11577/3389257 (postprint PDF) | akademik |
| 2 | A free-trajectory quasi-steady-state optimal-control method for minimum lap-time of race vehicles, *VSD* | 2019/2020 | M. Veneri, M. Massaro | research.unipd.it/handle/11577/3297111 | akademik |
| 3 | A three-dimensional free-trajectory QSS optimal-control method (g-g-g) | 2021 | S. Lovato, M. Massaro | research.unipd.it/handle/11577/3375385 | akademik |
| 4 | A quasi-steady-state minimum lap time simulation of race motorcycles using experimental data, *VSD* 62(2):372–394 | 2023 | J. Biniewicz, M. Pyrz | 10.1080/00423114.2023.2170256 | akademik |
| 5 | Doktora tezi (R6 Road Atlanta 89,658 vs 90,485 s; jerk sınırları β0/β1) | ~2023 | J. Biniewicz (PW Varşova) | bip.pw.edu.pl/…/final Rozprawa doktorska Jan Biniewicz.pdf | akademik |
| 6 | Lap time simulation and design optimisation of a brushed DC electric motorcycle for the Isle of Man TT Zero (29:31 vs 29:47) | 2018 | N. Dal Bianco, R. Lot, K. Matthys | eprints.soton.ac.uk/411613 | akademik |
| 7 | Optimal control of a road racing motorcycle on a three-dimensional closed track, *VSD* 58(8):1285–1309 | 2020 | L. Leonelli, D.J.N. Limebeer (yazarlar arama sonucunda teyit edilemedi) | pure.uj.ac.za/en/publications/optimal-control-of-a-road-racing-motorcycle-on-a-three-dimensiona/ | akademik (yazar doğrulanmadı) |
| 8 | Real-time Velocity Profile Optimization for Time-Optimal Maneuvering with Generic Acceleration Constraints (FBGA), IEEE RA-L 11(2) | 2026 | M. Piazza, M. Piccinini, S. Taddei, F. Biral, E. Bertolazzi | arxiv.org/abs/2509.26428 · github.com/DRIVEWISE/FBGA (MIT) | akademik |
| 9 | Minimum curvature trajectory planning and control for an autonomous race car, *VSD* 58(10):1497–1527 | 2020 | A. Heilmeier ve ark. | 10.1080/00423114.2019.1631455 | akademik |
| 10 | A Quasi-Steady-State Lap Time Simulation for Electrified Race Cars (EVER) | 2019 | A. Heilmeier, M. Geisslinger, J. Betz | ieeexplore.ieee.org/document/8813646 · github.com/TUMFTM/laptime-simulation | akademik |
| 11 | TUM Autonomous Motorsport: An Autonomous Racing Software for the Indy Autonomous Challenge, *J. Field Robotics* | 2023 | J. Betz ve ark. | 10.1002/rob.22153 | akademik |
| 12 | Outracing champion Gran Turismo drivers with deep reinforcement learning, *Nature* 602 | 2022 | P.R. Wurman ve ark. (Sony AI) | 10.1038/s41586-021-04357-7 | akademik |
| 13 | Lap Time Simulation: Comparison of Steady State, Quasi-Static and Transient Racing Car Cornering Strategies, SAE 2000-01-3563 | 2000 | B. Siegler, A. Deakin, D. Crolla | saemobilus.sae.org/content/2000-01-3563 | akademik |
| 14 | A quasi steady state approach to race car lap simulation in order to understand the effects of racing line and CoG location, Proc. IMechE D | 2005 | D.L. Brayshaw, M.F. Harrison | researchgate 238186382 (DOI doğrulanmadı) | akademik |
| 15 | Lap time simulation with transient vehicle and tyre dynamics (doktora tezi; Kelly & Sharp 2010 VSD makalesi **doğrulanmadı**) | 2008 | D.P. Kelly (danışman R.S. Sharp) | dspace.lib.cranfield.ac.uk/handle/1826/4791 | akademik |
| 16 | Advanced Motorcycle Virtual Rider (FISITA F2008-11-015) | 2008 | R. Lot, M. Massaro, R. Sartori | go.fisita.com/store/papers/FISITA2008/F2008-11-015 | akademik |
| 17 | A general method for the evaluation of vehicle manoeuvrability with special emphasis on motorcycles, *VSD* | 1999 | V. Cossalter, M. Da Lio, R. Lot, L. Fabbri | (DOI doğrulanmadı; Massaro & Limebeer 2021 ref.) | akademik |
| 18 | Extended QSS lap time simulation with transient iteration, SAE 2013-01-0806 | 2013 | T. Völkl, M. Muehlmeier, H. Winner | saemobilus.sae.org/content/2013-01-0806 | akademik |
| 19 | Meet MotoGP 19's A.N.N.A. (PlayStation Blog) | 2019 | M. Caletti (Milestone) | blog.playstation.com/archive/2019/04/04/meet-motogp-19s-a-n-n-a-… | geliştirici blogu |
| 20 | MotoGP 26 Rider-Based Handling röportajı | 2026 | M. Pezzotti (Milestone), Wccftech | wccftech.com/motogp-26-rider-based-handling-interview-milestone/ | geliştirici röportajı |
| 21 | How MotoGP 18 has taken gaming realism up a notch (Unreal geçişi) | 2018 | M. Caletti (Milestone), Motor Sport Magazine | motorsportmagazine.com/articles/motorcycles/motogp/how-motogp-18-has-taken-gaming-realism-notch | endüstri |
| 22 | GP Bikes Steam sayfası ("scratch-built physics", tyre model, MaxTyre) | — | PiBoSo | store.steampowered.com/app/848050/GP_Bikes/ | endüstri |
| 23 | PiBoSo forum: "Direct steer", "Fully disabling Lean Help", "counter steer without directsteer" | 2014– | topluluk + PiBoSo | forum.piboso.com/index.php?topic=28.0 / 6764.0 / 6624.0 (erişilemedi, arama özeti) | forum (doğrulanmadı) |
| 24 | RiMS Racing developer diary | 2021 | RaceWard (A. Carullo) | gtplanet.net/rims-racing-developer-diary-20210729/ | geliştirici blogu (ikincil) |
| 25 | TT Isle of Man RotE 3 developer aims to improve bike physics | 2023 | RaceWard / Nacon | traxion.gg/tt-isle-of-man-ride-on-the-edge-3s-developer-aims-to-improve-bike-physics/ | endüstri |
| 26 | Hirochi Outlaw (BeamNG mod sayfası) | 2024–25 | mod yazarı | beamng.com/resources/hirochi-outlaw.33927/ | geliştirici (mod) |
| 27 | Assetto Corsa AI hints (HINT_x, BRAKEHINT_x, DANGER_x) | — | Kunos notu, GTPlanet alıntısı | gtplanet.net/forum/threads/assetto-corsa-pc-mods-general-discussion.307899/post-13201174 | forum |
| 28 | TORCS robot tutorial / GetAllowedSpeed | — | B. Wymann; D. Gohourou | torcs.sourceforge.net/docs/ · godidier.github.io/drafts/torcs-ai-tuto-04.html | geliştirici blogu |
| 29 | Motorcycle Lap Time Simulator Built from Real Telemetry | ~2025 | A. Kozlenok | kozlenok.com/projects/lap-time-sim-moto | geliştirici blogu |
| 30 | Canopy platform | 2023+ | Canopy Simulations (Michelin) | simulation.michelin.com/canopy/canopy-platform | endüstri |

**Doğrulanmamış / bulunamayanlar:** ChassisSim, Pi/Cosworth ve VI-grade iç yöntemleri. Patton tezi. JBike6 URL'si. "pyRaceTelemetry" (böyle bir proje bulunamadı). PiBoSo fizik frekansı. RIDE ve SBK iç yapıları. Kelly & Sharp 2010 makale künyesi.

---

*Dosya: `/Users/macbookmini/projects/DDA_Reader/docs/superpowers/research/2026-10-11-r4-selection-games.md`*
