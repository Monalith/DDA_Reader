# R3 — Sürücü modeli, gaz ve fren kontrolü (owner maddeleri 4 ve 5)

2026-10-11. Kod değişikliği yok; bu bir araştırma notu. Bağlam: `specs/2026-10-09-virtual-rider-design.md`,
`notes/2026-10-10-virtual-vs-real.md`, `notes/2026-10-11-longitudinal-g.md`, `dda_lab/src/sim/rider.ts`.

Etiketler: **[akademik]** hakemli yayın, **[endüstri]** üretici/takım verisi, **[antrenör]** okul/koç
kaynağı, **[forum]** topluluk, **[ölçüm]** bizim BMW/R6 dosyalarımızdan, **[öneri]** bu notun önerisi
(kaynakla doğrulanmamış tasarım kararı), **(doğrulanmadı)** tam metin görülmeden alıntılanan bilgi.

---

## 1. Özet

1. Literatürdeki "rider" modellerinin (Sharp preview-LQR, Massaro/Lot virtual rider, Cossalter/Biral/Lot
   Optimal Manoeuvre Method, Massaro–Limebeer OCP) hiçbiri tarayıcıda gerçek zamanlı bir "corner-event"
   modeli olarak hazır değil; hepsi ya multibody + kapalı çevrim kontrolcü ya da NLP çözen optimal kontrol.
2. DDA Lab'a en yakın ve doğrudan uyarlanabilir akademik çerçeve **Veneri & Massaro (2020)** free-trajectory
   QSS + **Biniewicz & Pyrz (2024)** "jerk-sınırlı QSS"dir: g-g zarfı telemetriden yarı-ampirik çıkarılır ve
   ivme değişim hızı (jerk) hız-bağımlı sınırlarla kısıtlanır. Lateral jerk sınırı = roll rate sınırıdır.
3. Öneri: per-sample limit çözücüsünü **per-corner event modeline** çevir: her köşe için
   `brake → turn-in → apex → throttle pick-up → exit` beş olaydan oluşan **tek** bir şablon; fren ve gaz
   geçişi köşe başına **bir** kez. Hız profili bu olaylardan analitik parçalarla (jerk-sınırlı rampa, plato,
   lean-bağımlı trail release, bakım gazı, roll-on) üretilir; QSS zarfı yalnızca **üst sınır** olur.
4. Lastik tepe kaymada değil, kontrollü kaymada (`ρ = slip/slip_peak < 1`) sürülür; kullanılabilir sürtünme
   `μ_eff = μ_peak · f(ρ)` (Magic-Formula şekli), yani "risk" doğrudan `ρ`'yu seçer.
5. **Aggressiveness A** → roll rate (Biniewicz jerk sınırının kesri), fren build hızı, gaz roll-on hızı,
   pick-up gecikmesi. **Risk R** → `ρ` (kayma kesri) → fren g kesri, lean kullanımı, trail-brake derinliği.
6. Bizim ölçümlerimiz bu ayrımı destekliyor: iki sürücü fren tepe build'inde %4 içinde anlaşıyor
   (2.7/2.8 g/s, makine+agresiflik), ama ön lastiğe bir kez 0.85–0.95 g, kalan bölgelerde 0.54–0.72 g
   soruyor (risk/marj). Brembo MotoGP verisinde bile ana duruşta ortalama/tepe oranı 0.70–0.80.
7. Lag sabitleri bugün tur süresini etkilemiyor; event modelinde roll süresi ve pick-up gecikmesi doğrudan
   `∫ds/v`'ye girer, yani bu parametreler **ölçülebilir ve tur süresine bağlı** hale gelir.
8. Köşe segmentasyonu için ticari araçların (MoTeC/AiM/RaceChrono) yayınlanmış bir algoritması bulunamadı;
   pratik: hız minimumu = apex, eşikli long_g/lean/tps olayları. §3'te eğrilik + QSS hız profili üzerinde
   prominence-tabanlı somut algoritma veriyoruz.
9. Parametre kimliklendirme: köşe segmenti başına 4-5 parametreli en küçük kareler (hız izine fit) + g-g
   zarfı için Biniewicz'in hız-kutulu 3σ regresyonu; Ducati DDA kanalları (lean, tps, wheel_slip_pct, DTC)
   roll rate, pick-up ve kayma kesrini doğrudan verir (§6).
10. Şimdi uygula: segmentasyon + event şablonu + A/R eşlemesi + jerk sınırı. Ertele: preview-LQR, multibody,
    tam OCP.

---

## 2. Sürücü modeli karşılaştırma tablosu

| Model | Sürücü nedir (kontrolcü tipi) | Girdi → çıktı | Gerekli araç modeli | Hesap maliyeti | Corner-event'e indirgenebilir mi? |
|---|---|---|---|---|---|
| **Sharp 2007, road-preview steering** [akademik] | Doğrusal **optimal preview (LQR)** kontrolcü; ileriye bakılan yol noktaları ağırlıklı kazanç dizisiyle direksiyon torku üretir. Aynı yıl hız-takibi için preview kontrolcü (MSD 18). | Önizlenen yol sapmaları + araç durumu → steer torque (ve ayrı makalede sürüş/fren torku) | Doğrusallaştırılmış multibody motosiklet (Sharp–Limebeer tipi), hız noktası başına kazanç | Kazançlar çevrimdışı (Riccati) her hız için; çalıştırma ucuz ama multibody entegrasyonu gerekir | Kısmen: preview uzunluğu ve kazanç "ağırlıkları" agresiflik gibi okunabilir; ama olay (fren noktası) kavramı yok, yol izleyici. **Hayır, doğrudan değil.** |
| **Massaro & Lot virtual rider (2010 CDC; Massaro–Lot–Cossalter 2012)** [akademik] (doğrulanmadı: tam metin) | Önizlemeli, her anda gelecek yol kesitini ve mevcut durumu kullanan **predictive** kontrolcü; "bakan ve ne zaman fren/gaz yapacağına karar veren sürücü"yü taklit eder | Hedef yol + hız profili → steer torque, arka sürüş/fren torku, ön fren torku | Tam nonlineer multibody (FastBike/MBSLib), 50° roll'a kadar, stoppie/wheelie | Yüksek (zaman-alanı multibody); gerçek zamanlı değil | Hız profili **girdi**dir: yani bizim event modelimiz bu sürücüye hedef üretebilir. Kendisi indirgenemez. |
| **Optimal Manoeuvre Method — Cossalter, Da Lio, Lot, Fabbri 1999; Bertolazzi/Biral/Da Lio; Bobbo et al. 2009** [akademik] | Sürücü = **minimum-zaman optimal kontrol** çözümü (indirect, Pontryagin; "MOTORCYCLE"/PINS). Sürücü vücut hareketi bile kontrol değişkeni olabilir (Bertolazzi et al. 2007) | Yol + araç → tüm kontrol geçmişi (steer, throttle, ön/arka fren) ve yörünge | Multibody (hafif) veya basitleştirilmiş; sınırlar: kayma, wheelie/stoppie | Çok yüksek (NLP/BVP, dakikalar) | Sonuç olay yapısı içerir (tek fren, tek gaz) ama sürücü **her zaman sınırda**; owner kısıtı 2'ye aykırı. Ancak sınırlar (`μ`, jerk) küçültülerek "sub-maximal optimal" elde edilebilir. |
| **Massaro & Limebeer 2021 (review); Leonelli & Limebeer 2020 (3D, motosiklet)** [akademik] | Direct collocation OCP; sürücü = optimal kontrol | Pist şeridi + araç → kontroller, serbest yörünge | 3D yol, multibody veya QSS | Yüksek (IPOPT, saniyeler–dakikalar) | Aynı yorum: optimum = sınır. Review, QSS vs transient farkının çoğunlukla küçük olduğunu tartışır. |
| **Veneri & Massaro 2020, free-trajectory QSS-OCP** [akademik] | OCP, ama araç **QSS g-g(-v) zarfı** ile temsil edilir; yörünge serbest | Pist + g-g-v haritası → v(s), yörünge, a_x, a_y | Nokta kütle + önceden hesaplanmış g-g-v | Orta (NLP, ama küçük durum vektörü) | **En yakın aday.** Zarf ölçeklenebilir (risk), kontrol (jerk) sınırları agresifliğe bağlanabilir. Bizdeki 3-geçişli QSS'in genellemesi. |
| **Biniewicz & Pyrz 2024 (VSD 62) + Applied Sciences 14:4006** [akademik] | Free-trajectory QSS-OCP; kontroller **longitudinal ve lateral jerk**; jerk hız-bağımlı ampirik sınırlarla kısıtlı; g-g zarfı telemetriden yarı-ampirik | Pist (3D) + ölçülmüş zarf + jerk sınırları → v(s), a_x, a_y | Nokta kütle QSS motosiklet (Supersport, R6 için μ_y=1.13 raporlanıyor) | Orta | **Evet**: jerk sınırı = fren build/roll rate/roll-on sınırı. Road Atlanta'da sim 89.66 s vs gerçek 90.49 s (−0.83 s). Bizim için doğrudan parametre kaynağı. |
| **Kritayakirana & Gerdes 2012 (otomobil, Stanford)** [akademik] (doğrulanmadı) | Feedforward boyuna kontrol: g-g diyagramı + clothoid harita ile trail-braking ve throttle-on-exit | Yol eğriliği + g-g → boyuna komut | Bisiklet modeli araba | Düşük | **Evet**: köşe = clothoid giriş/sabit yarıçap/clothoid çıkış; olay modelinin otomobil versiyonu. |
| **Macadam 2003 review** [akademik] | Sürücü modelleri incelemesi: preview + işlem gecikmesi zorunlu öğeler | — | — | — | Gecikme parametresi kaynağı. |

**Sonuç:** Hiçbiri "sürücü bilinçli olarak sınırın altında kalır" varsayımını açıkça parametrelemiyor; hepsi
sınırı (veya ölçülmüş zarfı) kullanıyor. Biniewicz'in yaklaşımı bunu **ölçülmüş zarfı** kullanarak
örtük çözüyor: zarf, sürücünün gerçekten kullandığı ivmelerden (3σ) çıkarıldığı için sürücü marjını içeriyor.
Bizim A/R ayrımımız bunu açık iki parametreye bölmek demek.

---

## 3. Köşe segmentasyonu

### 3.1 Ticari araçlarda tanımlar (bulunan)

Arama sonucu: MoTeC i2, AiM Race Studio, 2D, Bosch WinDarab, Cosworth Pi Toolbox, Alfano, Apex Pro,
RaceChrono için **yayınlanmış otomatik köşe algılama algoritması bulunamadı**. Pratikte köşeler ya pist
haritasında elle konan bölümlerle (split/sector markers) ya da kanal eşikleriyle tanımlanıyor. Bulunanlar:

| Kavram | Pratik tanım (kaynak) | Not |
|---|---|---|
| Apex | Köşedeki **minimum hız** noktası (Assetto Corsa "Corners Performance" uygulaması; çoğu analiz aracı) [forum] | Geometrik apex (maks. eğrilik / iç kenara en yakın nokta) ile çakışmayabilir; LFS geliştiricisi apex'i çıkıştan geriye iz sürerek iç kenara en yakın nokta olarak buluyor [forum] |
| Fren noktası | Fren basıncı/long_g eşiği; elde edilen veri yoksa hız türevinin işaret değiştirdiği nokta | Bizde basınç kanalı yok → long_g |
| Turn-in | Lean/lateral g'nin yükselmeye başladığı nokta; roll rate tepe | DataMC roll rate = `abs(deriv(atan(GPS_LatAcc)))` math channel [forum/antrenör] |
| Throttle pick-up | Kapalı/bakım gazından sonra tps'in kalıcı yükselişi | Champ School verisi: ~2 s "neutral throttle" penceresi, sonra 23→100 % < 1 s [antrenör] |
| Corner exit | Lean'in düşmesi / tam gaz / bir sonraki fren | Tanım araca göre değişiyor |
| Köşe kümesi | Patentler (US 11710422 vb., "Driving analysis and instruction device") köşe başına turn-in, apex, fren noktası çıkarıyor [endüstri, doğrulanmadı: yöntem] | Algoritma ayrıntısı yok |

Akademik "otomatik yarış turu segmentasyonu" üzerine hakemli bir çalışma bu taramada bulunamadı. Aşağıdaki
algoritma bu nedenle **[öneri]**; eşikler mümkün olduğunca kendi ölçümümüze ve yukarıdaki pratiğe dayanır.

### 3.2 Tanımlar (DDA Lab için bağlayıcı öneri)

| Olay | Simülasyonda (eğrilik + QSS) | Gerçek veride (speed/lean/long_g/tps) |
|---|---|---|
| **B** brake point | Apex'ten geriye: event hız eğrisinin önceki sürüş eğrisini kestiği nokta | `long_g_tyre < −0.20 g` ve 0.3 s sürer (drag çıkarılmış); geriye doğru `long_g` ilk kez −0.05 g'yi aştığı yer |
| **T** turn-in | `|κ|` (20 m ölçekte) tepe değerinin %25'ini geçtiği nokta (B'den sonra) | lean > 8° ve roll rate > 20°/s |
| **A** apex | `v_event` minimumu (hız apex'i); ayrıca `κ` maksimumu "geometrik apex" olarak kaydedilir | hız minimumu (±0.5 s içinde lean maks. ile kontrol) |
| **P** throttle pick-up | A + `t_pick(A)` (hız apex'inden sonra) | tps > 10 % ve 0.3 s boyunca artan/sabit, A civarında aranır (A'dan önce de olabilir) |
| **E** exit | `|κ|` < tepe %25 **veya** lean < 15° **veya** sonraki B | lean < 15° veya tps > 90 % |

### 3.3 Algoritma (eğrilik-mesafe profili + QSS hız profili)

```
girdi: s[i] (2 m), kappa[i] (işaretli), v_lat[i] = sqrt(mu_y_eff*g/|kappa|) capped, v_qss[i] (3-geçiş)
parametre: L_k = 20 m (eğrilik ölçeği; notes/2026-10-10 §2: 10 m gürültü, 20 m gerçekçi)
           dV_min = max(8 km/h, 0.05*v_local)  (köşe prominence)  [öneri]
           k_frac = 0.25                         (turn-in/exit eğrilik kesri) [öneri]

1. kappa_s = savitzky_golay(kappa, pencere = L_k)        # L_k altını gürültü kabul et
2. adaylar = yerel_minimumlar(v_qss)                      # QSS çözümünde zaten hız apex'leri
   her aday için prominence = min(max v_qss sola kadar, max v_qss sağa kadar) - v_qss[aday]
   prominence < dV_min olanları at                       # dalgalanan per-sample fren olayları burada ölür
3. BİRLEŞTİR (köşe kompleksleri / şikan):
   ardışık iki apex a1,a2 arasında v_qss'nin a1'den yükselişi < dV_min ise
   veya aralarında tam gaz için yer yoksa (mesafe < v^2/(2*a_drive) ile hesaplanan min. ivmelenme mesafesi)
   -> TEK köşe bölümü: bir B, bir P; içeride birden fazla "lean flip" (şikan) olabilir.
   (Owner kısıtı 1: bölüm başına tek fren + tek gaz geçişi.)
4. Her bölüm için:
   A  = argmin v_qss (bölüm içinde);  A_geo = argmax |kappa_s|
   T  = A'dan geriye, |kappa_s| < k_frac*max|kappa_s| olan ilk nokta
   E  = A'dan ileriye, aynı eşik veya sonraki bölümün B'si (hangisi önceyse)
   B  = event hız profiliyle hesaplanır (bkz. §4/§5: v_A'dan geriye fren şablonu,
        önceki bölümün sürüş eğrisiyle kesişim)
   P  = A + t_pick (aggressiveness'tan), ama P >= A - 0.3 s  (erken gaz pozitif lean'de mümkün)
5. Yön işareti: sign(kappa_s[A_geo]); şikan içinde işaret değişimi = roll geçişi (flick), roll süresi
   = 2*phi/omega ile hesaplanır.
6. Doğrulama: bölüm sayısı ~ gerçek fren sayısı (Serres: 7–14 fren; sim şu an 16).
```

Notlar: (i) prominence filtresi sadece QSS profili üzerinde çalıştığı için 16 → gerçekçi sayıya inmesi
beklenir, ama Serres'te K-numaralı köşelerden bazıları (hızlı sağ-sol) gerçek sürücüde **frensiz**
geçilir: bu, `v_entry <= v_A` ise B olayı atlanır (yalnızca gaz kesme/bakım gazı) kuralıyla ele alınır.
(ii) Gerçek veride aynı algoritma `v_qss` yerine ölçülmüş hızla çalışır, eşikler aynı.

---

## 4. Sayısal tablolar

### 4.1 Fren zamanlaması ve şekli

| Büyüklük | Değer | Bağlam | Kaynak / etiket |
|---|---|---|---|
| MotoGP en sert duruş | 301→81 km/h, **5.2 s**, 246 m, lever 5.3 kg, tepe **1.5 g**, 11.3 bar | Red Bull Ring T4 | Brembo, crash.net 2025 [endüstri] |
| Aynı duruşun ortalaması | 61.1 m/s / 5.2 s = **1.20 g** → ortalama/tepe = **0.80** | hesap | [öneri: türetilmiş] |
| MotoGP Mandalika T1 | 303→106 km/h, 4.4 s, tepe 1.8 g (ortalama 1.27 g → 0.70) | | Brembo via thebrakereport [endüstri] (1.8 g şüpheli) |
| MotoGP tur ortalaması | ~1.16–1.23 g ortalama decel per fren | Losail / sezon | Brembo [endüstri] |
| Fren süresi / tur | ~29 s / tur (Avusturya, ~%33) | | Brembo [endüstri] |
| Build hızı (tepe fren bölgesi) | BMW **2.7 g/s** (0.40 s), R6 **2.8 g/s** (0.37 s) | Serres K1, yerleşik düzlükten | [ölçüm] notes/2026-10-11 §3 (üst sınır: düzleştirilmiş hız) |
| Boyuna jerk sınırı (path domain) | `dA_x/ds = β0/V + β1`, β0=15.70 m/s³, β1=−0.15 1/s² (zaman: `j = β0 + β1·V`) | Supersport, telemetriden | Biniewicz tez, Tablo 4.1 [akademik] |
| Applied Sci. katsayıları | j_x,acc β0=15.44 β1=−0.148; j_x,dec β0=−28.44 β1=0.148; j_y β0=32.56 β1=−0.378 | Road Atlanta Supersport | Biniewicz & Pyrz 2024 [akademik] (birim/normalizasyon doğrulanmadı) |
| Fren jerki o modelle (V=60 m/s) | 28.44 − 0.148·60 ≈ 19.6 m/s³ ≈ **2.0 g/s** | ölçümümüzle aynı mertebe | türetilmiş [öneri] |
| Trail-brake şekli | Basınç erken ve keskin yükselir (kısa yükleme duraksaması), lean arttıkça fren yükü viraj yüküne "takas edilir"; iz pürüzsüz rampa değil, "onlarca mikro-ayar" | MT-10, CMP T8 | Yamaha Champions School / Road Racing World 2025 [antrenör] |
| Freni bırakma → min hız | 67 mph'de fren bırakılır, min **62 mph** "kısa süre sonra" | aynı | [antrenör] |
| Sürücülerin ön lastikten istediği | tepe 0.85–0.95 g (bir kez), tipik **0.54–0.72 g** | BMW/R6 Serres, drag çıkarılmış | [ölçüm] |

### 4.2 Gaz zamanlaması

| Büyüklük | Değer | Kaynak |
|---|---|---|
| Neutral/maintenance throttle penceresi | ~**2 s** (fren bırakma → çıkış ivmesi) | Champ School 2025 [antrenör] |
| Roll-on | **23 % → 100 % < 1 s** | aynı [antrenör] |
| Gaz kapalıyken geçen toplam süre | ~7 s (143 mph fren → çıkış) | aynı |
| Boyuna ivme jerk sınırı (acc) | `j ≈ 15.4–15.7 − 0.15·V` m/s³ → V=30 m/s: ~11 m/s³ ≈ 1.1 g/s | Biniewicz [akademik] |
| Apex → ilk gaz | R6 dosyasında `gaz_pct` gerçek: segment başına ölçülebilir (henüz yapılmadı) | [ölçüm: yapılacak] |
| Mevcut rider.ts | `THROTTLE_ON_PCT_S=350` (~0.3 s tam), `BRAKE_ON_PCT_S=700` (~0.14 s) | tahmin, doğrulanmamış; 0.14 s build ölçülen 0.37–0.40 s'den **~3× hızlı** |

### 4.3 Roll rate

| Büyüklük | Değer | Kaynak |
|---|---|---|
| Şikan tam-lean → tam-lean | ~1.5 s → ortalama ~**60°/s**, tepe dik konumda (orta nokta) | Trevitt, Inside Motorcycles 2013 [antrenör] |
| Willow Springs T3→T4 geçişi | tepe ~**200°/s**; uzun köşe içinde < 10°/s | DataMC [antrenör/forum] |
| Hızla ilişki | Maks. roll rate hızla **düşer** | DataMC (nitel) |
| Lateral jerk → roll rate | `a_y = g·tanφ` ⇒ `φ̇ = j_y·cos²φ / g`; Biniewicz `j_y = 23.51 − 0.31·V` m/s³ | türetilmiş [öneri] |
| ⇒ V=20 m/s (72 km/h), φ≈0 | j_y=17.3 → **~101°/s** | türetilmiş |
| ⇒ V=40 m/s (144 km/h), φ≈0 | j_y=11.1 → **~65°/s**; φ=45°'de yarısı (~32°/s) | türetilmiş |
| MotoGP turn-in roll rate | Yayınlanmış ölçüm **bulunamadı** | — |

Yorum: Biniewicz zarfı 3σ sınırı olduğu için türetilen değerler "tipik maksimum"dur; DataMC'nin 200°/s
tepesi (düşük hız şikan, gyro'suz GPS-türevi) ve Trevitt'in 60°/s ortalaması aynı bandı çevreler.
**Turn-in süresi** ≈ `φ_A / ω̄`; ör. 50° lean, 70°/s ortalama → ~0.7 s; 144 km/h'de bu 28 m'dir. Bu
süre boyunca sürücü ne tam fren ne tam lateral kullanabilir: event modelinde **geçiş bölgesi** budur.

### 4.4 Sub-maximal kullanım ve gecikmeler

| Büyüklük | Değer | Kaynak |
|---|---|---|
| Fren g kesri (μ_x≈1.10 alınarak) | tepe 0.77–0.86, tipik 0.49–0.65 | [ölçüm] + μ_x Biniewicz [akademik] |
| MotoGP ortalama/tepe (ana duruş) | 0.70–0.80 | Brembo türetilmiş [endüstri] |
| Profesyonel sürücü sürtünme kullanımı | En iyiler fren→viraj geçişinde tüm sürtünmeyi kullanır (g-g dairesel); sürücüler benzer tur süresine farklı stillerle ulaşır | Kegelman, Harbott, Gerdes 2017 [akademik]; Stanford "Shelley" anlatımı [endüstri] |
| "Envelope'un kenarına ne kadar yaklaşıldığı sürücünün beceri ve kararlılığı" | nitel | HP Academy [antrenör] |
| İnsan işlem gecikmesi (preview modellerinde) | Zorunlu öğe; tipik 0.1–0.2 s | Macadam 2003 [akademik] (sayısal aralık doğrulanmadı) |
| Nöromüsküler dinamik (kol) | Ayrı birinci/ikinci derece blok | Pick & Cole 2008 [akademik] (sayı doğrulanmadı) |
| Acil fren tepki süresi (sokak) | 0.55–2.55 s | Davoodi et al. 2012 via Kovácsová 2020 [akademik, ikincil] |

Yarış sürüşünde fren noktası **beklenen** bir olaydır (preview); bu yüzden 0.5–2.5 s'lik reaksiyon süreleri
**uygulanmaz**. İlgili gecikmeler: fren build (0.37–0.40 s, ölçüm), turn-in roll süresi (0.4–1 s),
bakım gazı penceresi (~2 s antrenör, profesyonelde daha kısa) ve roll-on (<1 s). Bunlar şu anki lag
katmanındaki "first-order lag" yerine **tur süresine giren olay süreleri** olmalı.

---

## 5. Aggressiveness / risk eşlemesi

Tanım: `A ∈ [0,1]` (hız/zamanlama: ne kadar hızlı geçiş yapar), `R ∈ [0,1]` (marj: lastiği tepeye ne kadar
yaklaştırır). Lastik: normalize kayma `ρ = s/s_peak`; kuvvet kesri Magic-Formula şekliyle
basitleştirilmiş tepe-öncesi dal `f(ρ) = sin(π·ρ/2)` (ρ ≤ 1). Değerler: ρ=0.5 → f≈0.71, ρ=0.7 → ≈0.89,
ρ=0.9 → ≈0.99. (Tam Magic Formula `sin(C·atan(Bρ))` C=1.6 ile çok daha erken doyar — ρ=0.5'te ≈0.86 — bu yüzden
hangisinin doğru olduğu lastik verisiyle seçilmeli.) Bu **azalan getiri** riskin neden pahalı ama az kazandırdığını
(BMW 0.70 vs 0.85 fren: +0.83 s, notes/2026-10-11 §5) doğal biçimde ifade eder. [öneri; lastik eğri
parametreleri motosiklet lastik ölçümleri (ör. Cossalter et al. tyre characterization) ile doğrulanmalı —
doğrulanmadı]

| Türetilen büyüklük | Formül [öneri] | Uçlar (A/R=0 → 1) | Dayanak |
|---|---|---|---|
| Kayma kesri ρ (fren, ön) | `ρ_b = 0.30 + 0.65·R` | 0.30 → 0.95 | owner kısıtı 2; [öneri] |
| Fren g (lastik payı) | `g_b = μ_x · f(ρ_b)` | μ_x=1.10: ~0.50 → ~1.10 g; R=0.4 → ~0.85 (ölçülen tepe), R=0.15 → ~0.64 (ölçülen tipik) | [ölçüm] ile kalibre |
| Bölge-bölge varyasyon | tepe zon (en hızlı düzlük sonu) `ρ_b`, diğerleri `ρ_b − 0.15·(1−R)` | — | [ölçüm]: tek sert, diğerleri yumuşak; [öneri] |
| Lean kullanımı | `φ_use = φ_max · f(ρ_y)`, `ρ_y = 0.55 + 0.42·R` | ~%78 → ~%99 | [öneri] |
| Trail-brake derinliği | Fren lean ile azalır: `a_x(φ) = g_b·(1 − (φ/φ_use)^n)`, `n = 1 + 3·R` (yüksek R → fren daha derin lean'e taşınır); bırakma noktası `φ_rel = φ_use·(0.3+0.6·R)` | 0.3φ → 0.9φ | Champ School nitel takas; friction ellipse; [öneri] |
| Roll rate | `ω(V) = (0.5+0.5·A) · (β0+β1·V)/g · cos²φ` (Biniewicz j_y) | sınırın %50 → %100'ü: V=40 m/s'de ~33 → 65°/s | Biniewicz [akademik] + [öneri] |
| Fren build hızı | `J_b = (0.6+0.4·A) · J_b,max(V)`, `J_b,max` ≈ 2.8 g/s (ölçüm) veya `28.44−0.148V` | 1.7 → 2.8 g/s | [ölçüm] + Biniewicz |
| Throttle pick-up gecikmesi (A'dan) | `t_pick = 1.6 − 1.4·A` s (R yüksekse lean > φ_tp'de bile gaz) | 1.6 → 0.2 s | Champ School ~2 s penceresi (amatör üst uç) [antrenör] + [öneri] |
| Roll-on (0→100 %) | `t_roll_on = 1.2 − 0.8·A` s, ayrıca TC/wheelie sınırı | 1.2 → 0.4 s | Champ School <1 s [antrenör]; [öneri] |
| Çıkışta kayma (arka) | `ρ_d = 0.5 + 0.45·R`, DTC eşiği ile kesilir | | owner kısıtı 2; [öneri] |

Ayrışma kuralı: **A tur süresini zamanlama/geçişlerle**, **R kuvvet seviyesiyle** değiştirir. Yüksek A + düşük R
= "keskin ama marjlı" (hızlı roll, erken gaz, yumuşak fren); düşük A + yüksek R = "geç ama yumuşak geçişli,
sert fren". Bu iki eksen veride ayırt edilebilir (§6): A → `ω`, `J_b`, `t_pick`, `t_roll_on`; R → `g_b`,
`φ_use`, slip yüzdelikleri.

---

## 6. Parametre kimliklendirme tarifi

### 6.1 Genel yöntem (literatür)

- **g-g zarfı:** Biniewicz: hız kutuları (Δv) içinde ivme noktaları kutupsal (ρ, α) koordinata çevrilir, her
  açı dilimi için 3σ (alternatif p99) sınırı alınır, simetri için lateral aynalama, hızla doğrusal regresyon
  [akademik]. Biral & Lot 2009 "interpretative model of g-g diagrams" aynı amaca yönelik [akademik, doğrulanmadı].
- **Jerk sınırları:** ölçülen `da/dt` dağılımının hız kutularındaki sınırına `β0 + β1·V` fit [akademik].
- **Köşe segmenti bazlı en küçük kareler** [öneri]: her köşe bölümü için event modelinin hız izini ölçülene
  fit et: `θ_k = (s_B, g_b, J_b, v_A, t_pick, a_roll_on)`, amaç `Σ (v_sim − v_meas)²` + düzenlileştirme;
  Nelder–Mead, köşe başına < 1 ms.

### 6.2 BMW/R6 (yalnız hız; R6'da tps/vites)

1. Hız: 25 Hz OCR → Savitzky–Golay (0.5 s, 2. derece); bilinen artefaktları (BMW 360–384 m, R6 1645–1685 m)
   maskele.
2. `a_x = dv/dt`, tyre payı `a_x,tyre = a_x + lossDecelMs2(v)`.
3. §3 algoritmasıyla bölümler; her bölümde `g_b,peak`, `g_b,p50`, build (−0.1 g → %90 tepe süresi), `v_A`.
4. R6: `t_pick = t(tps>10 % kalıcı) − t(v_min)`, `t_roll_on = t(tps 20→90 %)`.
5. Lean ve lateral **yok**: `μ_y` yalnız `v_A²·κ(A)` ile ve κ belirsizliği (notes/2026-10-10 §2) nedeniyle
   güvensiz → R'nin lateral bileşeni bu dosyalardan **kimliklendirilemez**.

### 6.3 Ducati DDA turları (owner, Serres, 10 Hz gerçek GPS, en iyi 1:35.8, 10 tur)

Kanallar: speed, gps_speed, rpm, tps, gear, lean, wheel_slip_pct, DTC torque reduction (fast/slow),
accel_long/lat, wheelie flag. Fren basıncı yok.

**Ön işleme.** 10 tur; çıkış/giriş turlarını ve trafikli turları (tur süresi > en iyi + %3) at. Konum: GPS
→ yay uzunluğu; turlar arası hizalamayı tur başı + köşe apex'leri (hız minimumu) ile yap. Türev filtreleri:
10 Hz'de Savitzky–Golay pencere 7 örnek (0.7 s) — 0.37 s'lik fren build'i için kenarı yaklaşık %30 uzatır;
build için pencere 5 (0.5 s) ve sonucu "üst sınır" etiketle.

**(a) Fren g (GPS hız türevi).**
`a_x = d(gps_speed)/dt` (SG); `accel_long` kanalı ile çapraz kontrol (IMU eğimi/pitch ofsetini düzlükte
ortalama farkla kaldır). `a_x,tyre = a_x + loss(v)`. Fren olayı: `a_x,tyre < −0.20 g` ≥ 0.3 s. Her bölüm
için `g_peak`, `g_p50` (zon içi), build hızı = (0.1 g → 0.9·g_peak) / süre. Turlar arası medyan al.
Çıktılar: `g_b,top` (en hızlı düzlük sonu zonu), `g_b,typ` (diğer zonların medyanı), `J_b`.

**(b) Roll rate (turn-in).**
`ω = d(lean)/dt` (SG, işaretli; DataMC'nin uyardığı gibi mutlak lean'in türevini alma — şikanda işaret
hatası verir, türevi işaretli lean'den al, sonra mutlak). Turn-in penceresi `[T−0.3 s, A]` (T: lean > 8°).
Metrik: pencerede `ω_p90` ve ortalama `ω̄ = (φ_A − φ_T)/(t_A − t_T)`; giriş hızı `V_T`. Normalize:
`a_ω = ω_p90 / ω_bound(V_T, φ)` burada `ω_bound = (β0+β1·V)/g·cos²φ` (Biniewicz j_y). Ayrıca `accel_lat`
ile `tan(lean)·g` karşılaştırması lean kanalının doğruluğunu (rider body-lean farkı) kontrol eder.

**(c) Throttle pick-up ve roll-on.**
`t_pick = t_P − t_A`, `t_P` = A çevresinde (A−1 s … A+3 s) tps'in > 10 % olup 0.3 s boyunca düşmediği ilk
an; bakım gazı (5–20 % plato) varsa `t_P` platonun **sonundaki** kalıcı artış olarak ayrıca kaydedilir
(`t_maint`). Roll-on: `t(tps≥90 %) − t(tps≥20 %)`; DTC aktifse (torque reduction > 0) roll-on'u "TC-sınırlı"
olarak işaretle — orada sürücü değil elektronik sınırlıyor. Lean'i de kaydet: `φ_P` (gaz açılırken lean) →
erken gaz/yüksek risk göstergesi.

**(d) İzin verilen kayma (wheel_slip_pct).**
Çıkış fazlarında (P → E) slip dağılımı: `slip_p50`, `slip_p95` per köşe ve global. Tepe kayma referansı:
DTC'nin müdahale ettiği andaki slip (`slip_DTC` = DTC torque reduction'ın 0'dan ayrıldığı örneklerin slip
medyanı) — elektronik eşiği tepe-öncesi bir değerdir, `s_peak` için alt sınır. Öneri:
`ρ_d ≈ slip_p95 / slip_DTC` (≥1 ise sürücü sistematik olarak TC'ye dayanıyor → R yüksek). Fren fazında
slip kanalı muhtemelen ön tekeri referans aldığından anlamsızdır (doğrulanmalı); fren ρ'su (a)'dan gelir:
`ρ_b = f⁻¹(g_b / μ_x)`.

**(e) Lean kullanımı.** `φ_use = p99(lean)` köşe başına; `φ_use / φ_max,tyre` (φ_max preset'ten, ör. 55°).

**(f) Wheelie flag.** Çıkışta wheelie bayrağı + DTC → ivmenin wheelie-limitli olduğu bölgeler; bu bölgeler
roll-on fitinden çıkarılır.

**(g) A ve R'ye eşleme ve BMW/R6'ya karşı konum.**
1. Ölçülen her metriği §5 formüllerini tersine çevirerek bir A veya R tahminine çevir:
   - R adayları: `R_b = (ρ_b − 0.30)/0.65` (fren), `R_φ` (lean kullanımı), `R_d = (ρ_d − 0.5)/0.45` (çıkış slip).
   - A adayları: `A_ω = 2·a_ω − 1`, `A_J = (J_b/J_b,max − 0.6)/0.4`, `A_tp = (1.6 − t_pick)/1.4`,
     `A_ro = (1.2 − t_roll_on)/0.8`.
2. Her eksende ağırlıklı medyan (ağırlık = metriğin turlar arası tutarlılığı, 1/IQR). Tutarsızlık (ör. A_ω
   yüksek ama A_tp düşük) **ayrı raporlanır** — tek skalere sıkıştırmadan önce coaching bilgisi değeri taşır.
3. Referans çapası: BMW/R6 için yalnız fren metrikleri (ve R6'da t_pick, t_roll_on) ölçülebilir. Aynı formüllerle
   `R_b(BMW)`, `R_b(R6)`, `A_J(BMW/R6)`, `A_tp(R6)` hesapla ve owner ile aynı eksende göster. Owner'ın
   1:35.8'i ile referansların ~1:19.8'i arasındaki **16 s** fark tek başına A/R'den gelmez (makine, lastik,
   gün koşulu farklı olabilir); bu yüzden karşılaştırma **mutlak tur süresiyle değil, köşe-metrikleriyle**
   yapılır. Doğrulama: owner'ın fit edilmiş (A,R) + Ducati preset'i ile sim turu ≈ 1:35.8 vermeli; aynı
   (A,R) BMW preset'inde ne verdiği ise "aynı sürücü BMW'de" tahminidir.
4. İkinci aşama (global fit): (A, R, μ_x, μ_y) dört parametre üzerinden tüm turun hız izine en küçük kareler
   (§6.1), başlangıç değeri 1–3 adımlarından. μ'ler g-g zarfından (Biniewicz yöntemi) sabitlenirse yalnız A,R
   kalır → iyi koşullu.

---

## 7. DDA Lab için uygulanabilirlik

**Şimdi uygula**

1. **§3 segmentasyonu** (`corners.ts` gibi saf modül): prominence + birleştirme; testi "Serres'te bölüm
   sayısı 7–14" ve "her bölümde tek B ve tek P".
2. **Event şablonu** solver'ın backward/forward geçişlerinin yerine değil **üzerine**: her bölüm için
   `v_A = min(v_QSS(A), v(μ_y·f(ρ_y), φ_use))`, sonra A'dan geriye fren şablonu (build `J_b` → plato `g_b`
   → T'den itibaren `a_x(φ)` trail release, lean `ω` ile artar), A'dan ileri bakım gazı `t_pick` → roll-on →
   QSS sürüş zarfı. `v = min(event, QSS)`. Böylece fren olayları per-sample değil bölüm başına bir kez oluşur
   ve `rider.ts`'teki event-merging sezgiseline gerek kalmaz.
3. **A ve R slider'ları**: mevcut `brakingG`, `throttle delay`, `lean usage`, `trailBrake` slider'ları
   A/R'den türetilen varsayılanlar olur (gelişmiş panelde override edilebilir).
4. **Biniewicz jerk sınırı** ile roll rate ve fren build: `ω(V)` ve `J_b(V)` formülleri; `BRAKE_ON_PCT_S`
   (0.14 s) ölçülen 0.37–0.40 s ile değiştirilmeli.
5. **Ducati kimliklendirme betiği** (§6.3 a–g) — `tests/unit/gTraceMetrics.ts` desenini izleyerek.

**Ertele**

- Sharp preview-LQR / Massaro-Lot virtual rider: multibody gerektirir, extension seam arkasında kalır.
- Tam OCP (Veneri–Massaro, Biniewicz): tarayıcıda NLP pahalı; ancak serbest yörüngeyi istersen ileride
  WASM-IPOPT ile düşünülebilir. Bugünkü κ-çizgisi + event modeli yeterli.
- Lastik Magic-Formula katsayılarının ölçümle kalibrasyonu (`f(ρ)`): şimdilik tek şekil parametresi, kaynak
  bulunana kadar [öneri].
- Nöromüsküler/işlem gecikmesi blokları: yarış sürüşü önizlemeli olduğu için tur süresine etkisi olay
  süreleri içinde zaten var; ayrı gecikme bloğu gerekmez.

**Riskler.** (i) `f(ρ)` şekli ve ρ→A/R lineer eşlemeleri kalibre edilmemiş öneridir; ilk fit Ducati verisiyle
yapılmalı. (ii) Biniewicz katsayıları Supersport/Road Atlanta'dan; Applied Sci. ile tez arasında farklı
değerler var (lateral β0 23.51 vs 32.56) — normalizasyon farkı olabilir, kullanmadan önce tam metinden teyit.
(iii) BMW/R6'da lateral kanal olmadığından R'nin lateral bileşeni yalnız Ducati'den gelir.

---

## 8. Kaynaklar

| # | Kaynak | Yıl | DOI / URL | Etiket |
|---|---|---|---|---|
| 1 | Sharp, R.S. "Motorcycle Steering Control by Road Preview", J. Dyn. Sys., Meas., Control 129(4):373 | 2007 | https://asmedigitalcollection.asme.org/dynamicsystems/article/129/4/373/470099 (DOI 10.1115/1.2745842 doğrulanmadı) | akademik |
| 2 | Sharp, R.S. "Optimal preview speed-tracking control for motorcycles", Multibody Syst. Dyn. 18:397–411 | 2007 | 10.1007/s11044-007-9079-x | akademik |
| 3 | Cossalter, Da Lio, Lot, Fabbri "A General Method for the Evaluation of Vehicle Manoeuvrability with Special Emphasis on Motorcycles", VSD 31:113–135 | 1999 | 10.1076/vesd.31.2.113.2094 | akademik |
| 4 | Bobbo, Cossalter, Massaro, Peretto "Application of the Optimal Maneuver Method for Enhancing Racing Motorcycle Performance", SAE Int. J. Passeng. Cars 1:1311 | 2009 | 10.4271/2008-01-2965 | akademik |
| 5 | Massaro, M., Lot, R. "A virtual rider for two-wheeled vehicles", 49th IEEE CDC, pp. 5586–5591 | 2010 | https://www.research.unipd.it/handle/11577/2437523 (tam metin doğrulanmadı) | akademik |
| 6 | Massaro, Lot, Cossalter — predictive virtual rider (Proc. IMechE D) | 2012 | https://journals.sagepub.com/doi/ref/10.1177/0954407012440217 (doğrulanmadı: başlık/sayfa) | akademik |
| 7 | Veneri, M., Massaro, M. "A free-trajectory quasi-steady-state optimal-control method for minimum lap-time of race vehicles", VSD 58:933–954 | 2020 | 10.1080/00423114.2019.1608364 | akademik |
| 8 | Massaro, M., Limebeer, D.J.N. "Minimum-lap-time optimisation and simulation", VSD 59:1069–1113 | 2021 | 10.1080/00423114.2021.1910718 | akademik |
| 9 | Leonelli, L., Limebeer, D.J.N. "Optimal control of a road racing motorcycle on a three-dimensional closed track", VSD 58:1285–1309 | 2020 | 10.1080/00423114.2019.1617886 | akademik |
| 10 | Biniewicz, J., Pyrz, M. "A quasi-steady-state minimum lap time simulation of race motorcycles using experimental data", VSD 62(2):372–394 | 2024 | 10.1080/00423114.2023.2170256 | akademik |
| 11 | Biniewicz, J., Pyrz, M. "Influence of the Road Model on the Optimal Maneuver of a Racing Motorcycle", Applied Sciences 14:4006 | 2024 | 10.3390/app14104006 | akademik |
| 12 | Biniewicz, J. Doktora tezi (Politechnika Warszawska) — jerk sınırları Tablo 4.1, g-g zarfı yöntemi | ~2024 | https://www.bip.pw.edu.pl/content/download/63672/588949/file/final%20Rozprawa%20doktorska%20Jan%20Biniewicz.pdf | akademik |
| 13 | Biral, F., Lot, R. "An interpretative model of g-g diagrams of racing motorcycle", ICMEM | 2009 | (doğrulanmadı — yalnız ref. listesinde görüldü) | akademik |
| 14 | Massaro, Lovato, Veneri "An optimal control approach to the computation of g-g diagrams", VSD 62:448–462 | 2024 | 10.1080/00423114.2023.2178467 | akademik |
| 15 | Kegelman, J.C., Harbott, L.K., Gerdes, J.C. "Insights into vehicle trajectories at the handling limits: analysing open data from race car drivers", VSD 55(2):191–207 | 2017 | 10.1080/00423114.2016.1249893 | akademik |
| 16 | Kritayakirana, K., Gerdes, J.C. — trail-braking/throttle-on-exit feedforward (Stanford DDL) | ~2012 | https://ddl.stanford.edu/publications/thesis/autonomous-vehicle-control-limits-handling (doğrulanmadı: makale künyesi) | akademik |
| 17 | Macadam, C.C. "Understanding and Modeling the Human Driver", VSD 40(1–3):101–134 | 2003 | (DOI doğrulanmadı) | akademik |
| 18 | Pick, A.J., Cole, D.J. "A mathematical model of driver steering control including neuromuscular dynamics", J. Dyn. Sys. Meas. Control 130(3):031004 | 2008 | 10.1115/1.2837452 | akademik |
| 19 | Rice, R.S. "Rider Skill Influences on Motorcycle Maneuvering", SAE 780312 | 1978 | https://saemobilus.sae.org/papers/rider-skill-influences-motorcycle-maneuvering-780312 | akademik |
| 20 | Davoodi, S.R., Hamid, H. "Motorcyclist Braking Performance in Stopping Distance Situations", J. Transp. Eng. | 2013 | 10.1061/(ASCE)TE.1943-5436.0000552 | akademik |
| 21 | Brembo / crash.net "Brutal Austrian MotoGP braking load revealed by Brembo" | 2025 | https://www.crash.net/motogp/news/1079248/1/brembo-motogp-riders-brake-33-lap-red-bull-ring | endüstri |
| 22 | Brembo / The Brake Report — Indonesia, Malaysia, Qatar analizleri | 2022–2025 | https://thebrakereport.com/brembo-rates-indonesian-motogp-moderate-on-brakes/ | endüstri |
| 23 | Spalding, C. / Yamaha Champions Riding School "Champ School: Unlock Pro Cornering With Real Data", Road Racing World | 2025-12-23 | https://www.roadracingworld.com/news/champ-school-unlock-pro-cornering-with-real-data/ | antrenör |
| 24 | Trevitt, A. (byline IM Admin) "Roll Rate: How quickly can you turn?", Inside Motorcycles | 2013-02-21 | https://www.insidemotorcycles.com/roll-rate-how-quickly-can-you-turn-2/ | antrenör |
| 25 | DataMC "Roll Rate — Data for Motorcycles" (AiM math channel) | ~2018 | https://www.datamc.org/data-acquisition/gps-data-analysis/roll-rate/ | antrenör/forum |
| 26 | LFS forum — apex/köşe algılama uygulaması | — | https://lfs.net/forum/post/1901554 | forum |
| 27 | US 11710422 / 11830375 "Driving analysis and instruction device" | — | https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11710422 | endüstri (yöntem doğrulanmadı) |
| 28 | Kendi ölçümlerimiz: `notes/2026-10-11-longitudinal-g.md`, `notes/2026-10-10-virtual-vs-real.md` | 2026 | repo | ölçüm |

Bulunamayanlar (açıkça): MoTeC/AiM/Cosworth/Bosch'un yayınlanmış köşe-algılama algoritması; MotoGP/WSBK
turn-in roll rate ölçümü; trail-brake basınç-vs-lean nicel eğrisi (Ken Hill dahil); hakemli otomatik
yarış-turu segmentasyonu çalışması.
