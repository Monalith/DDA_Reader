# Sanal Sürücü (Virtual Rider) — Durum

Son güncelleme: 2026-10-10.

Bu dosya repoda duruyor çünkü `~/.claude/projects/.../memory/` altındaki notlar şu anda
yazıldıktan saniyeler sonra kesiliyor (Qdrant koleksiyonu named-vector şemasına geçmiş, istemciler
unnamed default bekliyor; veri kaybı yok, 214 kayıt sağlam ama istemciler açamıyor). Bir oturumun
"kod yok" diye bayat bir not okuyup aynı işe sıfırdan başlaması bu yüzden gerçekten oldu.

## Nerede ne var

- **Spec:** `docs/superpowers/specs/2026-10-09-virtual-rider-design.md`
- **Plan:** `docs/superpowers/plans/2026-10-09-virtual-rider.md`
- **Ledger, brief'ler, review paketleri:** `.superpowers/sdd/2026-10-09-virtual-rider/`
  (git-ignored; `progress.md` tüm kararların ve gerekçelerin kaydı)

## Dallar — DİKKAT

| Dal | Nerede | Ne |
|---|---|---|
| `feature/virtual-rider` | `/Users/macbookmini/projects/DDA_Reader` | Task 1-4 + 3b, `c7f6125`. **Ayrıca başka bir oturumun commit'lenmemiş işi var — dokunulmadı.** |
| `feature/virtual-rider-wt` | `/Users/macbookmini/projects/DDA_Reader-vr` | Task 5+ burada. node_modules symlink. |

Paylaşılan ağaçta canlı bir eşzamanlı yazıcı bulunduğu için worktree'ye geçildi. Sonunda iki dalın
merge'i gerekecek. Paylaşılan ağaçta **`git add -A` kullanma**.

## Tamamlananlar

| Task | Ne | Commit |
|---|---|---|
| 1 | Web-Mercator karo matematiği + mozaik | `3758c8d..7dec6c8` |
| 2 | Uydudan asfalt kenarı çıkarma | `7dec6c8..72f0209` |
| 3 | Bridge'de koridor deposu (GET açık / PUT token'lı) | `72f0209..8537645` |
| 3b | Koridoru coğrafi kenar polyline'ı olarak sakla (paylaşılabilirlik) | `a09a892..f8b0e3f` |
| 4 | Koridoru haritaya çiz + görsel kapı | `a52be68..c7f6125` |
| 5 | Makine/lastik/sürücü preset'leri + clamp | `4fe330a` |
| 6 | κ yarış çizgisi | `cd518e3` |

Her biri bağımsız review'dan geçti; bulgular ve kararlar ledger'da.

## Doğrulanmış gerçekler (tekrar keşfetme)

- **`dda_lab_bridge.py` zaten production'da canlı.** kos-web droplet (159.89.97.78) → nginx →
  systemd `dda-lab` (`/opt/dda-lab`, :8777) → cloudflared → `https://dda.kitchenonstage.com`.
  `deploy_lab.sh` her deploy'da bridge'i yükler. CORS `allow_origins=["*"]`.
- **`DDA_CORRIDOR_TOKEN` droplet'te HENÜZ SET EDİLMEDİ** → koridor deposu şu an read-only (PUT 503).
- **TUZAK:** `src/bridge/client.ts:5` `BRIDGE_BASE = 'http://127.0.0.1:8777'` sabit — deploy'da
  ziyaretçinin kendi makinesini çağırır. Koridor istemcisi bu yüzden same-origin kullanıyor.
- **`SchemaLayer.trackOutline` pist koridoru İÇERMEZ.** Ölçüldü: `racing_line` ile aynı eğri,
  medyan ayrım 1680 px'lik görüntüde 5,2 px. Bu fikri tekrar deneme.
- **Uydu segmentasyonu çalışıyor.** Esri z18 = 0,450 m/px, tile CORS `*`. Ayırt edici
  **doygunluk** (yol üstü 0,069 / çevre 0,239), parlaklık değil.
- **Serres koridoru: %65 resolved, medyan 14,5 m.** 14,5 m doğru — kurb ve banket dahil
  (`gapTolerance` 4 adım = 2 m köprüler). Pist beyaz çizgiler arası ~12 m.
- **`?example=` dosya adı değil id alır:** `bike1000`, `bike600`, `intermediate`. Otomasyon altında
  (`navigator.webdriver`) geçerli bir id verilmezse hiçbir şey yüklenmez (`App.tsx:14`).
- **Her ziyaretçi kendi centerline'ını kurar** (`buildCenterline`, `trackActions.ts:127`), bu yüzden
  koridor vertex-indeksli saklanamaz — coğrafi kenar polyline'ı olarak saklanıyor.

## Açık işler

- Task 7 (QSS çözücü), 8 (sürücü gecikme katmanı), 9 (sentetik Session), 10 (SimPanel + canlı
  slider), 11 (gerçek BMW turuna karşı karakter kıyası).
- Kullanıcı istekleri (2026-10-10 sabahı): gaz↔fren geçişinde faz farkı; trail-braking için iki
  slider (viraja ne kadar derin + fren profili); risk/düşme uyarısı.
- Deploy adımı (`DDA_CORRIDOR_TOKEN` + `./deploy_lab.sh`) henüz yapılmadı.
