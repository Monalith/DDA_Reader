# Sürücü modeli yeniden gözden geçirme — iş planı

Tarih: 2026-10-11. Durum: **ONAY BEKLİYOR** (kullanıcıya sunuldu, henüz hiçbir agent başlatılmadı).
Dal: `feature/virtual-rider` (son commit 3030215). Mevcut spec: `specs/2026-10-09-virtual-rider-design.md`.

## 0. Neden yeniden bakıyoruz — mevcut modelin fotoğrafı

| Katman | Şu an ne var | Bilinen zayıflık |
|---|---|---|
| Araç | Nokta-kütle; `P/(m·v)`, CdA sürüklenme, wheelie sınırı `g·L/(2h)` | Yük transferi, pitch, süspansiyon yok; fren tavanı tek skaler `brakingG` |
| Lastik | Skaler μ × gripScale + sürtünme **elipsi**; lean tavanı `tan(leanMax)` | Kamber itişi, slip, kombine kayma, sıcaklık yok; μ=1.33 doğrulanmamış varsayım (±2,5 s / 0,1) |
| Yol | 2B centerline + uydu koridoru; **eğim ve banking yok** | Serres'te eğim var; fren/ivme bütçesine girmiyor |
| Çizgi | Min-eğrilik / min-mesafe karışımı (κ) koridor içinde | κ "stil" parametresi gerçek GPS çizgisiyle hiç doğrulanmadı |
| Boylamsal çözücü | QSS 3 geçiş + fren yükselme hızı (`brakeRiseGps`) + trail-brake derinlik/profil | Her virajda tavanda frenler (gerçek sürücü 1 kez 0,85-0,95 g, kalanında 0,54-0,72 g); 16 fren uygulaması vs gerçek 7-14 |
| Sürücü | Gecikme katmanı: `tps/brake/gear/rpm/dtc` birinci-derece lag + olay birleştirme | Hiçbir `rider.ts` sabiti zarfı etkilemiyor; oranlar tahmin, ölçüm değil |
| Doğrulama | BMW 1:19.81 ve R6 1:19.849 (`_inbox/`), 68 % otomatik okunmuş hız | Gerçek lateral g, fren basıncı, TPS yok → geçiş şekilleri karşılaştırılamıyor |

Kaynak: `notes/2026-10-10-virtual-vs-real.md` §5, `notes/2026-10-11-longitudinal-g.md` §5.

**Hedef:** Araştırmaya dayalı olarak her katman için "doğru seviye"yi seçmek, spec'i buna göre düzeltmek, sonra uygulamak. Kısıt değişmiyor: çıktı sıradan bir `Session`, tarayıcıda slider canlı (< ~50 ms), parametreler DDA verisinden gözlemlenebilir olmalı.

---

## 0.1 Kullanıcı tasarım kısıtları (2026-10-11, bağlayıcı)

Bu üç kural spec v2'nin omurgasıdır; araştırma ve uygulama bunlara hizmet eder.

1. **Bir viraj kesitinde tek fren ve tek gaz geçişi vardır.** Sürekli gaz-fren yapılmaz. Model
   örnek-başına (per-sample) değil **viraj-olay tabanlı** çalışır: her viraj için sırayla
   *fren noktası → turn-in → apex → gaz noktası → çıkış* belirlenir ve hız profili bu olaylardan
   üretilir. Mevcut `rider.ts` olay-birleştirme yaması (MERGE_GAP_S, SAME_CORNER_*) bir semptom
   tedavisidir; yerini viraj segmentasyonu alır. Fren sayısı = viraj sayısı (fren gerektirmeyen
   virajlar hariç).
2. **Kayma (slip) şu an çok yüksek.** Lastik sürtünme tavanında değil, **daha düşük slip açısı ve
   slip oranı** çalışma noktasında modellenir. Sürücü lastiği zirveye değil, zirvenin altında
   kontrol edilebilir bir slip bölgesine sürer. Bu, "tavanda frenle" davranışının (açık #3) kökten
   çözümüdür.
3. **Sürücü agresifliği ve risk alma iki ayrı parametredir.** Bunlar en az şunları belirler:
   - **yatma hızı** (roll rate, °/s) — turn-in'in ne kadar hızlı olduğu, dolayısıyla fren noktası
     ile apex arasındaki mesafe;
   - **izin verilen slip** (slip açısı / slip oranı tavanı) — lastik zirvesine ne kadar yaklaşıldığı.
   Mevcut `brakingG`, `leanUsage`, `trailBrakeProfile` gibi doğrudan fizik sliderları bu iki
   üst-parametreden türetilen değerler olur (kullanıcı isterse ince ayar için açık kalır).

Araştırmaya etkisi: R2 slip eğrilerini (Fy–slip açısı–kamber, Fx–slip oranı, zirve slip
değerleri), R3 viraj segmentasyonu algoritmalarını (telemetriden fren noktası / apex / gaz noktası
tespiti; MoTeC/AiM/Bosch "corner analysis" yaklaşımı), gerçek sürücü roll-rate aralıklarını ve
agresiflik↔slip eşlemesini kapsar.

## 0.2 Doğrulama verisi envanteri (2026-10-11 tespiti)

Kaynak dizin: `/Volumes/Dock SSD/Downloads/dda/` (harici disk; takılı değilse "çalışmıyor" sanma).
Kopyalar: `DDA_Reader/_inbox/` (2026-10-11'de `.gitignore`'a eklendi; içinde `corridor-token.txt` var, asla commit edilmez).

| Dosya | Pist | İçerik | Konum doğruluğu | Kullanım |
|---|---|---|---|---|
| `Run036-219926-00.00.{dda,json}` | Serres (41.07, 23.52) | **Sahibin Ducati DDA kaydı**, 10 tur, en iyi **1:35.8**, 10 Hz gerçek GPS (10 089 fix), kanallar: speed, gps_speed, rpm, tps, gear, lean, **wheel_slip_pct**, torque_fast/slow (DTC), accel_long/lat, wheelie | gerçek GPS (~2-3 m) | **Birincil doğrulama**: çizgi, lateral g, slip, DTC, κ |
| `Run018-211670-00.00.{dda,json}` | Serres | 11 tur, en iyi 1:38.5, aynı kanallar | gerçek GPS | ikincil / tur-tur tutarlılık |
| Run010/016/023/039 (SSD'de) | Serres | 4-11 tur, 1:38-1:40 | gerçek GPS | parametre fit için ek örnekler |
| `serres_BMW_1-19-81.json` | Serres | Video overlay'den okunmuş hız/lean/long_g, 68 % otomatik | ±20 m, GPS yok | hızlı sürücü referansı (tur süresi, köşe hızları) |
| `serres_R6_1-19-849.json` | Serres | aynı tür | ±20 m | ikinci hızlı referans |
| `serres_RaceChrono_1-29-7.json`, `1-29-2.json` | Serres | RaceChrono overlay okuması | ±20 m | orta hız referansı |
| `sample_run.dda` | Sonoma | Ducati DDA, tur yok | gerçek GPS | format testi |

Sonuç: açık #2 (gerçek lateral g bilinmiyor) ve #6 (κ doğrulanmamış) artık **çözülebilir** —
Run036 gerçek çizgiyi, lateral g'yi ve lastik slip'ini doğrudan veriyor. Doğrulama koşumu (W4)
iki seviyeli olur: (a) sahibin lap'ı → çizgi/slip/lean/DTC uyumu, (b) BMW/R6 → agresiflik ve
risk parametreleri yükseltildiğinde tur süresi ve köşe hızlarının 1:19-1:20 bandına gelmesi.

## 1. Faz planı (özet)

```
Faz 1  Araştırma        4 Opus agent paralel  → docs/superpowers/research/*.md   (~45-60 dk)
Faz 2  Sentez + seçim   Fable                 → notes/2026-10-11-model-selection.md
Faz 3  Spec audit       Fable                 → specs/2026-10-11-virtual-rider-design-v2.md
        ── KULLANICI ONAYI (spec v2) ──
Faz 4  Uygulama planı   Fable (writing-plans) → plans/2026-10-11-rider-model-v2.md
Faz 5  Uygulama         3-5 Opus agent paralel, dosya-çakışmasız iş paketleri
Faz 6  Doğrulama+birleştirme  Fable: review, BMW/R6 karşılaştırma, Playwright, tek commit
```

---

## 2. Faz 1 — Araştırma (Opus, paralel)

Kullanıcının 7 başlığı birbiriyle örtüşüyor; tekrar aramayı önlemek için **4 agenta** gruplandı. Her agent kendi dosyasına yazar, ortak dosya yok. Her rapor: kaynak listesi (yıl, DOI/URL), model karşılaştırma tablosu, "DDA Lab için uygulanabilirlik" bölümü (tarayıcıda hesaplanabilir mi, hangi parametreler DDA kanallarından çıkar), ve açık net öneri.

| # | Agent | Kapsadığı kullanıcı başlıkları | Araştırma soruları | Çıktı |
|---|---|---|---|---|
| R1 | **Araç + 3B tek-iz modelleri** | 1, 2 | Sharp (1971, 1994, 2001) ve Cossalter/Lot (FastBike) çok-gövdeli modeller; Whipple/Koenen kararlılık modları (wobble, weave, capsize); nokta-kütle → "bisiklet modeli + roll" → 4-DOF Sharp merdiveni; **3B yol** üzerinde tek-iz: Limebeer & Sharp, Massaro & Lot, Dal Bianco "optimal manoeuvre on 3D roads", Leonelli & Limebeer — eğim/banking/eğrilik torsiyonunun fren ve lateral bütçesine etkisi; Darboux çerçevesi; yük transferi + wheelie/stoppie sınırlarının analitik ifadeleri; DEM veri kaynakları (Copernicus 30 m, Mapzen/AWS Terrain Tiles, SRTM) pist eğimi için yeterli mi | `research/2026-10-11-r1-vehicle-3d-road.md` |
| R2 | **Motosiklet lastik modeli** | 3 | Pacejka Magic Formula motosiklet uzantısı (MF-Tyre 6.x, kamber ≤ 60°+); Sharp'ın kamber itişi / yan kayma ayrımı; **sürtünme elipsi ne kadar geçerli** (g-g diyagramı, lean'e bağlı asimetri); kombine kayma; yarış slick'i μ aralıkları (gerçek MotoGP/WSBK lateral g 1,4-1,7 ?); sıcaklık/basınç etkisi — hangisi QSS'e sığar; Veneri & Massaro **g-g-v zarfı** (önceden hesaplanmış, hıza bağlı ivme sınırları) yaklaşımı | `research/2026-10-11-r2-tyre.md` |
| R3 | **Sürücü modeli + gaz/fren kontrolü** | 4, 5 | Sharp (2007) önizlemeli LQR sürücü; Cossalter/Massaro sürücü direksiyon torku ve gövde lean kontrolü; Biral/Lot/Da Lio minimum-süre optimal manevra; **boylamsal kontrol**: trail-braking fren basıncı profilleri (Brembo MotoGP verileri, Bosch telemetri yayınları), gaz uygulama gecikmesi ve TC davranışı; nöromüsküler gecikme (0,15-0,3 s); "sürücü tavanın altında frenler" davranışının literatürdeki modeli (risk/konfor marjı, sub-maximal braking); fren uygulama sayısı/virajda tek squeeze; **parametre kimliklendirme**: gerçek laplardan μ, brakingG, gecikme sabiti nasıl fit edilir | `research/2026-10-11-r3-rider-control.md` |
| R4 | **Model seçimi + oyun motorları + tur-süresi simülatörleri** | 6, 7 | QSS vs free-trajectory QSS vs transient optimal-control karşılaştırması (Massaro & Limebeer 2021 derleme; Brayshaw & Harrison; Patton; Siegler); ticari/açık tur-süresi araçları (OptimumLap, ChassisSim, Canopy, Lap Time Sim. QSS) — hangi fidelite hangi hata; **oyun motorları**: GP Bikes/MX Bikes (Piboso), MotoGP/Ride (Milestone), TT Isle of Man (Kylotonn), BeamNG, Assetto Corsa modları — sürücü nasıl ayrı gövde, otomatik dengeleme, "rider as rigid body on ride-on" ; oyun AI'ı tur süresini nasıl hesaplıyor (racing line + hız profili); **seçim matrisi**: doğruluk / hesaplama maliyeti / gözlemlenebilirlik / tarayıcı uygulanabilirliği | `research/2026-10-11-r4-selection-games.md` |

**Agent ayarı:** `subagent_type: general-purpose`, `model: opus` (Opus 5.5), `effort: medium` (kullanıcı kuralı). Web erişimi serbest. Derin araştırma izni bu mesajda açıkça verildi ("Opus ile internette bunları araştır").

**Çıkış kriteri:** 4 rapor dosyada; her biri en az 10 birincil kaynak; her kaynak için güven düzeyi (akademik / endüstri / forum).

---

## 3. Faz 2 — Sentez ve en doğru yöntem seçimi (Fable)

Fable 4 raporu okur, şu kararları `notes/2026-10-11-model-selection.md`'ye yazar:

| Karar | Seçenek uzayı | Seçim kriteri |
|---|---|---|
| Araç modeli seviyesi | nokta-kütle (mevcut) / yük-transferli nokta-kütle / 4-DOF Sharp | Tarayıcı bütçesi + DDA'dan gözlemlenebilirlik; wheelie/stoppie analitik yeterse çok-gövdeli ret |
| Lastik | skaler μ + elips (mevcut) / lean'e bağlı asimetrik g-g / g-g-v zarfı | Gerçek lateral g doğrulanabilir mi; 0,1 μ = 2,5 s hassasiyeti düşürür mü |
| 3B yol | yok (mevcut) / DEM eğim yalnız boylamsal / eğim + banking | Serres için DEM çözünürlüğü anlamlı mı; kazanım > gürültü mü |
| Çizgi | κ karışımı (mevcut) / serbest-yörünge QSS / min-time OCP | Gerçek GPS çizgisiyle doğrulanabilirlik; hesap süresi |
| Boylamsal sürücü | tavanda fren (mevcut) / sub-maximal fren modeli / olay-tabanlı tek squeeze | Fren sayısı 16→7-14 bandına iner mi; p25 long_g referans bandına girer mi |
| Gecikme sabitleri | tahmin (mevcut) / literatür değerleri / laptan fit | En az biri ölçülebilir olmalı |

Her karar: seçilen yöntem, reddedilenler ve **neden**, beklenen etki (saniye / km/h), risk.

## 4. Faz 3 — Spec audit (Fable)

Mevcut spec `2026-10-09-virtual-rider-design.md` ile **kodun gerçek hali** zaten ayrışmış. Audit üç kaynağı karşılaştırır: spec ↔ kod ↔ Faz 2 kararları.

Bilinen drift (önden tespit):
- Spec "κ = eğrilik dağılım şekli" diyor; kod min-eğrilik/min-mesafe karışımı (12bbc65).
- Spec'te `trailBrakeDepth/Profile`, `brakeRiseGps`, `risk.ts`, fren tarafında aero/rolling katkısı **yok**.
- Spec'te lean işareti konvansiyonu yok; kodda uygulamaya uyduruldu (sol = negatif).
- Spec "Parameters" tablosu güncel `RiderParams` ile eşleşmiyor.
- Testing bölümü 4 test dosyası sayıyor, gerçekte 13.
- Extension seam hâlâ doğru, ama g-g-v / 3B yol gelirse `simulate(track, corridor, params)` imzasına `elevation` girmeli.

Çıktı: `specs/2026-10-11-virtual-rider-design-v2.md` — (a) kodla uyumlu "as-built" bölümü, (b) Faz 2 seçimlerine göre "to-be" bölümü, (c) değişiklik günlüğü, (d) ertelenen/ret edilen maddeler. **Bu noktada kullanıcı onayı alınır; onaysız koda dokunulmaz.**

## 4.1 Faz 1-3 DURUMU (2026-10-11 ~14:10): TAMAMLANDI

- Araştırma: `research/2026-10-11-r1..r4-*.md` (4 Opus raporu, ~100 kaynak, 13:28-13:50).
- Sentez: `notes/2026-10-11-model-selection.md` (K1-K10 kararları, çelişkiler, veri gerçeği).
- Spec v2: `specs/2026-10-11-virtual-rider-design-v2.md` — **ONAY BEKLİYOR**.
- Kullanıcı sapma onayı: free-trajectory + tam OCP ayrı modlar olarak eklendi (spec §2.10).

## 5. Faz 4-5 — Uygulama planı ve paralel uygulama (spec v2'ye göre güncellendi)

Faz 4'te Fable `superpowers:writing-plans` ile görev-görev planı yazar. İş paketleri Faz 2 kararına bağlı; aşağıdaki **aday** bölünme dosya çakışmasızdır (kesinleşmesi spec v2 sonrası):

| Paket | Dosyalar (yalnız bu paket dokunur) | Agent / model | İçerik (aday) |
|---|---|---|---|
**Sıra:** Önce **W0 (Fable)**: `types.ts` arayüzleri (`SolverMode`, `Corner`, `DerivedRider`, yeni Machine/Tyre alanları, `Line.slopeRad/bankRad/nu`) ve `derive.ts` iskeleti tek commit'te sabitlenir. Sonra W1-W6 paralel, kimse `types.ts`'e dokunmaz (gerekirse Fable'a mesaj).

| Paket | Dosyalar (yalnız bu paket dokunur) | Agent / model | İçerik (spec v2 §) |
|---|---|---|---|
| W1 Araç + lastik + 3B altyapı → zarf | `src/sim/vehicle.ts` (yeni), `src/sim/tyre.ts` (yeni), `src/sim/solver.ts`, `tests/unit/simVehicle.test.ts`, `simTyre.test.ts`, `simSolver.test.ts`, `simLongG.test.ts` | general-purpose, **opus**, medium | §2.1 stoppie/wheelie/h_φ, crown+hang-off lean ters çözüm; §2.2 g(s) elipsi, μx/μy; §2.3 g̃/ã bütçesi, sıfır kanal = v1 bit-bit; §2.5 roll-rate kısıtı zarfa |
| W2 Serbest-yörünge modu | `src/sim/freeTrajectory.ts` (yeni), `src/sim/freeTrajectory.worker.ts` (yeni), `src/sim/optCache.ts` (yeni), `tests/unit/simFreeTrajectory.test.ts` | general-purpose, **opus**, medium | §2.10 satır 2: koridor içinde çizgi ofset optimizasyonu + QSS iç döngü (s=1); Web Worker, ilerleme, önbellek; solver'ı yalnız **çağırır** |
| W3 Viraj segmentasyonu + olay şablonu + rider | `src/sim/corners.ts` (yeni), `src/sim/events.ts` (yeni), `src/sim/rider.ts`, `tests/unit/simCorners.test.ts`, `simEvents.test.ts`, `simRider.test.ts`, `tests/unit/circuitFixture.ts` | general-purpose, **opus**, medium | §2.4 prominence+birleştirme, hasBrake; §2.5 fren build/plato/release, bakım gazı, roll-on, `v=min(event,qss)` C¹; §2.7 kanallar olaylardan, sezgiseller silinir; Biniewicz β0 teyidi |
| W4 Doğrulama koşumu + Ducati kimliklendirme | `scripts/sim-validate.ts` (yeni), `scripts/ducati-identify.ts` (yeni), `tests/unit/simSerres.test.ts`, `tests/unit/gTraceMetrics.ts`, `_inbox/*.json` okunur | general-purpose, **opus**, medium | §4a slip lean düzeltmesi, metrikler → A/R tahmini; §4b viraj metrikleri + kabul tablosu; başta v1 üzerinde çalışır (baseline), W1/W3 bitince yeniden koşar |
| W5 Tam OCP köprüsü (sunucu) | `dda_lab_bridge.py`, `tests/test_bridge.py`, `ocp/` (yeni: fastest-lap sarmalayıcı, iş kuyruğu), `deploy_lab.sh`, `src/sim/ocpClient.ts` (yeni) | general-purpose, **opus**, medium | §2.10 satır 3: `POST/GET /ocp/jobs`, tek işçi kuyruk, 15 dk zaman aşımı, token, sonuç saklama; istemci polling; **önce yerelde**, droplet dağıtımı kullanıcı onayıyla |
| W6 Preset + derive + UI + dokümantasyon | `src/sim/presets.ts`, `src/sim/derive.ts`, `src/sim/index.ts` (mode anahtarı), `src/sim/risk.ts`, `src/state/store.ts`, `src/ui/panels/SimPanel.tsx`, `src/ui/SimLayers.ts`, `tests/unit/simDerive.test.ts`, `simStore.test.ts`, `simRisk.test.ts`, `simPresets.test.ts`, `docs/MATH_GUIDE.md` | general-purpose, **opus**, medium (UI + store = v1'de en çok kırılan yer, sonnet değil) | §2.6 A/R eşleme tablosu tek yerde; §2.8 μ_eff banner; §2.9 mod anahtarı, Hesapla, gelişmiş panel, B/T/A/P/E katmanı; üç sim session aynı anda |

Kural: `solver.ts`'e yalnız W1, `types.ts`'e yalnız W0 (Fable), `store.ts` ve `index.ts`'e yalnız W6 dokunur. W2 ve W3 solver'ı çağırır ama değiştirmez. W5 tamamen Python + tek yeni TS istemci dosyası; TS tarafıyla çakışmaz.

## 6. Faz 6 — Doğrulama ve birleştirme (Fable)

1. Her paket için `superpowers:requesting-code-review` → bulgular düzeltilir.
2. `npm run typecheck`, tüm Vitest (≥ 456 + yeniler), Python bridge testleri.
3. Kabul metrikleri (BMW 1:19.81 referansı):
   - tur süresi hatası ≤ 0,5 s (şu an 0,66 s)
   - köşe minimum hızı RMSE ≤ 5 km/h (şu an K3/K4/K16'da 11-15 km/h)
   - fren uygulaması sayısı 7-14 bandında (şu an 16)
   - long_g p25 referans bandı −0,70 ± 0,1 g içinde
4. Playwright görsel doğrulama (dev server, slider → harita + grafik güncelleniyor) — proje kuralı.
5. Tek commit (`feat(sim): rider model v2 — …`), push. DDA Lab dağıtımı `deploy_lab.sh` ile, kullanıcı isterse.

---

## 7. Agent / model özeti

| İş | Yürütücü | Model | Effort | Paralel? |
|---|---|---|---|---|
| Plan, sentez, spec audit, uygulama planı, review, birleştirme | Fable (ana döngü) | claude-fable-5-1 | — | sıralı |
| R1-R4 araştırma | 4 × general-purpose | opus (Opus 5.5) | medium | evet, aynı anda |
| W0 arayüzler (types.ts, derive iskeleti) | Fable | claude-fable-5-1 | — | önce, tek |
| W1-W6 uygulama | 6 × general-purpose | opus (Opus 5.5) | medium | evet (W0 sonrası) |
| Kod incelemesi | code-review skill (Fable) | — | high | paket başına |

Tahmini süre: Faz 1 ≈ 1 saat duvar saati; Faz 2-3 ≈ 1 saat Fable; Faz 5 ≈ 1-2 saat paralel; Faz 6 ≈ 1 saat.

## 8. Kullanıcı başlıklarının dışına çıkan genişletmeler (plan ekleri)

- **3B yol verisi (DEM)** — "3 boyut" başlığının pratik karşılığı; eğim olmadan Serres frenleri yanlış ölçeklenir.
- **Parametre kimliklendirme** — μ ve brakingG'yi gerçek laptan fit etmeden hiçbir model "doğru" sayılamaz (açık #2).
- **Doğrulama koşumu (W4)** — bugüne kadar elle yapılan karşılaştırma tekrar edilebilir test oluyor.
- **Risk eşiği** — `gripUse` banner eşiği gürültü tabanında (açık #5); R2 lastik raporu gerçek eşik için girdi verir.
- **Çizgi doğrulaması** — κ'nın stil parametresi olarak doğrulanması GPS'li lap ister; R3/R4'ten "GPS yoksa ne yapılır" çıkmazsa ertelenir ve spec v2'de açıkça yazılır.

## 9. Açık sorular (kullanıcıya)

1. Faz 1 araştırması **şimdi** başlatılsın mı, yoksa planda değişiklik var mı?
2. Doğrulama için GPS'li gerçek bir Serres lap'ı var mı (DDA .dda dosyası)? Varsa yolu — çizgi ve lateral g doğrulaması buna bağlı.
3. Oyun motoru araştırmasında (R4) GP Bikes gibi "fizik ağır" simülatörlere mi, yoksa MotoGP/Ride gibi arcade-sim arası başlıklara mı ağırlık verilsin? Varsayılan: ikisi de, fizik ağır olanlara öncelik.
