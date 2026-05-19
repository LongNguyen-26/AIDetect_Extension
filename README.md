# AIDetect Admin - Facebook Group Post Review Extension

README nay mo ta extension trong thu muc `AIDetect_Extension` de co the tiep tuc bao tri trong session khac.

## Muc tieu

Extension ho tro admin/moderator duyet bai Facebook Group bang cach quet cac bai viet dang cho duyet, tinh diem rui ro AI, hien badge canh bao tren card bai viet va co che do tu dong duyet/xoa theo cau hinh.

Manifest hien tai:

- Manifest V3.
- Ten extension: `AIDetect Admin - Group Post Review`.
- Content script chay tren `*://*.facebook.com/*`.
- Background service worker xu ly scan, rule check, stats.
- Permissions: `storage`, `activeTab`.
- Host permissions: Facebook va `https://api.aidetect.vn/*`.

## Cau truc file

```text
AIDetect_Extension/
  README.md
  B2B_Level/
    manifest.json
    content.js
    background.js
    popup.html
    popup.js
```

Vai tro tung file:

- `B2B_Level/manifest.json`: khai bao Chrome Extension MV3.
- `B2B_Level/content.js`: script chay trong Facebook, tim card bai cho duyet, extract noi dung, render badge, xu ly manual/auto moderation.
- `B2B_Level/background.js`: service worker nhan message tu content script, cham diem bai viet, check group rules va cap nhat thong ke.
- `B2B_Level/popup.html`: UI popup cau hinh che do quet, nguong diem, rule group, action auto.
- `B2B_Level/popup.js`: logic popup, dong bo cau hinh vao `chrome.storage.sync`.

## Che do hoat dong

Extension co 3 mode:

- `off`: tat scan.
- `manual`: tu dong nhan dien card bai cho duyet va quet/hien badge, nhung khong thao tac duyet/xoa.
- `auto`: quet theo batch va co the thuc hien action duyet/xoa theo cau hinh.

Cau hinh mac dinh trong `content.js` va `background.js`:

```js
aidetectAdminMode: "off"
aidetectAdminThreshold: 85
aidetectAdminMinTextLength: 8
aidetectAdminAutoAction: "approve_only"
aidetectAdminAutoRunning: false
```

`approve_only` co nghia la auto chi duyet bai hop le, bai rui ro se bi skip. `approve_and_delete` co the xoa bai bi danh gia khong hop le.

## Luong xu ly chinh

1. `content.js` duoc inject vao Facebook o `document_idle`.
2. `init()` load settings, tao floating button, setup listener va observer.
3. MutationObserver goi lai scan khi Facebook re-render DOM.
4. `findPendingPostCards()` tim cac card bai dang cho duyet.
5. `buildCardPayload()` extract text, media count, links, mode, group rules.
6. `scanCardAsync()` gui message `SCAN_PENDING_POST` den `background.js`.
7. `background.js` tra ve `score`, `type`, `reason`, `signals`.
8. `content.js` render badge neu score >= threshold.
9. Neu auto mode dang chay, `analyzeAndDecide()` tinh verdict va co the click approve/delete.

## Logic tim card Facebook

Facebook Group pending posts khong co selector on dinh, nen logic khong nen dua vao class name hash nhu `x1...`.

Logic hien tai trong `findPendingPostCards()` dung nhieu dau hieu:

- Nut approve/reject co text/aria-label tuong ung.
- Container co `[aria-posinset]` cua virtualized list.
- Checkbox `input[name^="pending-post-checkbox-"]`.
- Link pending post: `/pending_posts/`.
- Link media/post: `set=gm.*`, `story_fbid=`.
- Fallback `div[role="article"]`.

`normalizePendingPostCards()` sau do:

- Loc lai candidate hop le bang `isValidPendingCard()`.
- Gom candidate theo slot `[aria-posinset]`.
- Chon candidate tot nhat trong tung slot bang `getPostCandidateScore()`.
- Dedupe theo stable key de tranh lay trung nested container.
- Sort theo vi tri top tren viewport.

Day la phan quan trong nhat de tranh bug "chi lay bai dau va bai cuoi, bo sot bai giua".

## Cache va trang thai sau Facebook re-render

Facebook thuong thay the DOM node cu bang node moi khi co bai moi, scroll, virtualize list hoac update UI. Vi vay khong duoc chi dua vao `WeakSet`, `WeakMap` hoac `data-*` tren DOM node.

Co che hien tai gom 2 lop:

- Node-local cache:
  - `scannedCards` (`WeakSet`)
  - `observedCards` (`WeakSet`)
  - `resultCache` (`WeakMap`)
  - `cardDecisions` (`WeakMap`)
  - `warningStateByCard` (`WeakMap`)

- Stable cache:
  - `contentHashCache`: cache result theo hash noi dung.
  - `cardStateCache`: cache result/decision/warning/cardIndex theo stable key.
  - `warningStateByCardKey`: dem warning theo stable key de khong mat hoac dem trung badge sau re-render.

Stable key uu tien theo thu tu:

1. Checkbox name: `pending-post-checkbox-*`.
2. Post id lay tu link: `/pending_posts/{id}`, `set=gm.{id}`, `story_fbid`, `fbid`, `/posts/{id}`.
3. Fallback: `hash:{contentHash}`.

Khi DOM moi xuat hien, `hydrateCardFromStableState()` se:

- Tinh payload va content hash hien tai.
- Tim state cu theo stable key/content hash.
- Gan lai `data-aidetect-admin-content-hash`.
- Restore result vao `resultCache`.
- Render lai badge neu dang o manual mode.
- Restore decision neu dang auto mode.

Neu stable key giong nhau nhung content hash khac nhe do Facebook re-render text/DOM khac, extension giu badge cu tam thoi va queue scan lai. Truong hop nay duoc goi la `contentHashDrift`.

## Badge va UI tren card

Badge duoc render boi `renderBadge()` vao `.aidetect-admin-badge-host`, thuong gan sau header card.

Neu score >= threshold:

- Hien badge canh bao.
- Outline card mau do.
- Tang counter tren floating button.

Neu score < threshold:

- Khong hien badge.
- Xoa outline neu co.

Badge dung Shadow DOM de giam xung dot CSS voi Facebook.

## Background analyzer

`background.js` hien dang bat:

```js
const USE_MOCK_REVIEW_DATA = true;
```

Khi mock bat:

- Mot so card duoc gan ket qua mock theo `cardIndex` hoac text pattern.
- Rule check cung la mock heuristic.

Khi thay bang API that:

- Sua `analyzePendingPost(payload)` de goi API AIDetect production.
- Nen giu output shape:

```js
{
  score: number,
  type: string,
  reason: string,
  signals: [{ label: string, confidence: number }],
  summary?: string
}
```

## Popup settings

Popup cho phep:

- Chon mode: off/manual/auto.
- Chinh threshold 70-95.
- Nhap group rules.
- Chon auto action.
- Bat/tat auto moderation.
- Reset stats.

Settings luu trong `chrome.storage.sync`, stats luu theo ngay.

## Debug card detection

De debug `normalizePendingPostCards()` tren Facebook console:

```js
localStorage.setItem("aidetectAdminDebugCards", "1");
location.reload();
```

Sau reload, console se co log:

```text
AIDetect Admin: normalizePendingPostCards raw=... valid=... selected=...
```

Log dung `console.table()` voi cac cot:

- `kind`: candidate hoac selected.
- `posinset`: vi tri slot Facebook virtualized list.
- `top`, `height`, `width`: vi tri/kich thuoc DOM.
- `score`: diem chon candidate noi bo.
- `approve`, `reject`: so nut action tim thay.
- `key`: stable key cua card.
- `hash`: content hash.
- `text`: text preview.

De tat debug:

```js
localStorage.removeItem("aidetectAdminDebugCards");
location.reload();
```

Co the bat nhanh khong reload bang:

```js
window.__AIDetectAdminDebugCards = true;
```

## Cai dat extension de test thu cong

1. Mo Chrome/Edge.
2. Vao `chrome://extensions`.
3. Bat Developer mode.
4. Chon "Load unpacked".
5. Chon folder:

```text
C:\CS_Major\Contests_2025\UED_StartUp\AIDetect_Extension\B2B_Level
```

6. Mo trang Facebook Group pending posts.
7. Mo popup extension va chon manual hoac auto.

## Lenh kiem tra nhanh

Repo hien khong co package/test runner rieng. Co the check syntax bang Node:

```bash
node --check B2B_Level\content.js
node --check B2B_Level\background.js
```

Kiem tra whitespace git:

```bash
git diff --check
```

## Luu y quan trong khi tiep tuc phat trien

- Khong dua vao class name Facebook vi class bi hash va thay doi lien tuc.
- Khi sua logic tim card, uu tien marker co y nghia: aria-label, checkbox name, pending post link, `aria-posinset`.
- Khong chi cache theo DOM node. Facebook re-render se lam mat WeakMap/WeakSet/data-attribute.
- Khi them cache moi, nen co fallback theo `contentHash`.
- Khi update badge, can cap nhat ca warning count theo stable key de tranh dem trung.
- Auto mode co click approve/delete that, nen test bang mock/manual truoc.
- `USE_MOCK_REVIEW_DATA` dang la `true`; can can nhac tat khi tich hop API that.

## Cac ham nen doc truoc khi sua

Trong `B2B_Level/content.js`:

- `findPendingPostCards()`
- `normalizePendingPostCards()`
- `isValidPendingCard()`
- `extractPendingPostText()`
- `buildCardPayload()`
- `getCardStableKey()`
- `hydrateCardFromStableState()`
- `scanPendingPosts()`
- `autoScanCycle()`
- `analyzeAndDecide()`
- `renderOrRemoveBadge()`

Trong `B2B_Level/background.js`:

- `handlePendingPostScan()`
- `analyzePendingPost()`
- `getMockPendingPostResult()`
- `handleGroupRulesCheck()`
- `updateStats()`

## Trang thai gan day

Gan day da sua bug Facebook re-render va bo sot card o giua:

- Mo rong discovery card tu approve button sang approve/reject, slot `aria-posinset`, checkbox pending post va pending links.
- Normalize theo slot thay vi loai bo ancestor qua rong.
- Them stable state cache de restore badge khi DOM node cu bi thay.
- Them debug log co the copy tu console.

