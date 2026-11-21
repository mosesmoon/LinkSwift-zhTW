# LinkSwift 繁中版

LinkSwift 繁中版是以 [hmjz100/LinkSwift](https://github.com/hmjz100/LinkSwift) 為基礎的分支，用於取得網盤檔案的下載連結。本分支額外提供繁體中文（台灣）介面，並支援 [Mister Download Manager（MDM）](https://github.com/anefzaoui/misterdownloadmanager) 下載。

> [!IMPORTANT]
> 本專案所取得的下載連結，均基於各大網盤服務商公開的 API 介面。  
> 專案未以任何形式承諾、宣傳或實現對網盤限速機制、功能的破解。
>
> 若在實際使用中獲得較快的下載速度，通常是由於服務商介面策略、使用者本機網路環境，或服務商階段性的頻寬調整所致，  
> 請勿誤解為本專案具備破解限速的能力或提供相應服務。

> [!IMPORTANT]
> 本專案始終遵循合規與克制的原則，堅持技術中立，不觸及、不損害任何網盤服務商的核心利益，  
> 僅為協助無法或不便使用官方用戶端的使用者，實現合法的檔案下載需求。
>
> 任何第三方在推廣、轉載或介紹本專案時所作出的誇大或誤導性宣傳（包括但不限於「加速下載」「速度起飛」「限速破解」等說法），均不代表本專案立場。  
> 由此產生的一切後果與責任，與本專案無關，須由相關行為主體自行承擔。

## 安裝

1. 先安裝一款使用者腳本管理器（擇一即可）：
   - [Tampermonkey](https://www.tampermonkey.net/)
   - [ScriptCat（腳本貓）](https://scriptcat.org/)
   - [Violentmonkey](https://violentmonkey.github.io/)
2. 在瀏覽器中開啟以下連結，並依腳本管理器的提示完成安裝：

   ```
   https://raw.githubusercontent.com/mosesmoon/LinkSwift-zhTW/dev/dist/LinkSwift.zh-TW.user.js
   ```

注意事項：

- 安裝後的腳本名稱為 `LinkSwift 繁中版`。它是獨立的腳本，可與原版 LinkSwift 並存，但同一頁面請勿同時啟用兩者。
- 腳本會從上述網址自動更新，無需手動重新安裝。
- 原版 LinkSwift 的安裝來源與說明，請參考 [上游專案](https://github.com/hmjz100/LinkSwift)。

## 功能

- 支援九大網盤：百度網盤、阿里雲盤、中國移動雲盤、天翼雲盤、迅雷雲盤、光鴨雲盤、夸克網盤、UC 網盤、123 雲盤。
- 取得直連下載連結，並美化網盤頁面的下載按鈕與視窗，支援深色模式與主題色設定。
- 支援多種下載方式：
  - API 下載，可一鍵複製全部連結，或複製 Aria2、cURL 命令。
  - 增強下載，支援多區塊多執行緒。
  - 推送到 Aria2（RPC）、比特彗星、IDM、AB Download Manager（ABDM）。
  - 複製 Mister Download Manager（MDM）命令列，見下方說明。
- 百度網盤分享頁支援選擇資料夾下載。

## Mister Download Manager（MDM）下載

1. 在網盤的下載選單中選擇 `MDM 下載`。每個檔案會顯示一段命令，點擊即可複製；若有多個檔案，可使用「複製全部」。
2. 在 LinkSwift 的設定中，填寫 `MDM 命令列工具路徑`，即 `misterdownloadmanager-cli.exe` 的完整路徑（Windows 預設安裝在 `C:\Program Files\Mister Download Manager\`）。此工具多半不在系統的 PATH 內，因此需要手動指定。
3. 在設定中選擇 `MDM 命令類型`：
   - `get`（預設）：MDM v0.5.2 即可使用。下載會在終端機中進行，帶上全部請求標頭，但不會出現在 MDM 主程式的下載清單。
   - `add`：需要支援 `add` 子命令的較新版 MDM，並先開啟 MDM 主程式；下載交給主程式處理，只帶 Referer、User-Agent 與 Cookie。
4. 在設定中選擇 `終端類型`，須與您貼上命令的終端機相符：`命令提示字元`、`PowerShell`、`Linux` 或 `macOS`。

> [!WARNING]
> 命令中會包含 Cookie 等標頭資訊，會留在終端機的歷史紀錄中。若電腦為多人共用，請在使用後清除終端機歷史紀錄。

MDM 專案：<https://github.com/anefzaoui/misterdownloadmanager>

## 開發與建置

- 原始碼維持與上游相同的簡體中文，主檔為 `（改）网盘直链下载助手.user.js`。
- 安裝相依套件：`npm install`
- 建置繁中版：`npm run build:zhtw`。此指令會透過 OpenCC 轉換為台灣慣用詞，輸出 `dist/LinkSwift.zh-TW.user.js`。用於字串比對的內容會依 `tools/zhtw-protect.json` 保持不變，轉換報告則輸出至 `temp/zhtw-report.md`。
- 執行測試：`npm test`
- 程式檢查：`npm run check`（會以 eslint --fix 自動修改檔案）
- 請勿直接手動修改 `dist/` 內的檔案，應修改原始碼後重新建置。

## 授權與致謝

本專案採用 [AGPL-3.0-or-later](LICENSE) 授權，與上游專案相同。

- 上游專案：[hmjz100/LinkSwift](https://github.com/hmjz100/LinkSwift)，作者 hmjz100。
- 本腳本基於 [【網盤直鏈下載助手】](https://www.baiduyun.wiki/install.html) 修改：
  - 原作者：[油小猴](https://www.youxiaohou.com/)
  - 原倉庫：[syhyz1990/baiduyun](https://github.com/syhyz1990/baiduyun)

感謝 hmjz100、油小猴，以及所有為 LinkSwift 上游與本分支提供協助的開發者。
