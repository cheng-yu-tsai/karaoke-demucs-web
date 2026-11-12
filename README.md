# 聲軌工房｜Demucs Web 前端移植

以 [timcsy/demucs-web](https://github.com/timcsy/demucs-web) 的 HTDemucs ONNX 實作為基礎，將原始音軌分離 Demo 改成繁體中文的伴奏製作頁面。

## 使用

需要 Python 3 才能啟動靜態檔案伺服器（不執行媒體處理）。在這個資料夾執行：

```powershell
python server.py
```

接著開啟 <http://localhost:8081>。首次按下「分離人聲」時，瀏覽器會從 Hugging Face 載入約 172 MB 的 ONNX 模型。模型與音訊推論都在瀏覽器執行；使用者的媒體不會傳到伺服器。

## GitHub Pages 部署

推送到 `main` 後，`.github/workflows/deploy-pages.yml` 會自動發布此靜態網站。GitHub Pages 的部署方式需設為 GitHub Actions；部署網址會顯示在 repository 的 Actions 執行結果中。

可選音訊或影片。分離完成後可下載 WAV 伴奏；若選的是影片，可用瀏覽器即時播放與錄製原畫面及伴奏，下載 WebM 伴奏 MV。WebM 輸出使用瀏覽器原生 `MediaRecorder`，目前不重新編碼 MP4。

## 瀏覽器與效能

- 建議使用近期版 Chrome 或 Edge。WebGPU 可用時會優先使用；其他情況走 WASM。
- 靜態伺服器送出 COOP/COEP 標頭以支援 WASM 多執行緒。外部 ONNX Runtime 與模型仍由瀏覽器下載。
- HTDemucs 會分段處理整首音訊。長音訊會佔用較多記憶體；速度取決於裝置 GPU/CPU。
- 可各自預聽／下載鼓、Bass、Other、人聲四軌；伴奏混音可調整鼓、Bass、Other 三軌音量，並可將伴奏升降 12 個半音而保持時長。升降 Key 使用 [SoundTouchJS AudioWorklet](https://github.com/cutterbl/SoundTouchJS) 的瀏覽器端離線處理（MPL-2.0）。
- RGB 燈效使用 Web Audio Analyzer 讀取伴奏播放中的頻率能量，在頁面內以紅／綠／藍光暈即時反應；可開關及調整亮度。
- Demucs Web 模型只輸出四軌；Other 是吉他、鍵盤等其他伴奏的合併軌，無法由此模型再個別分離。
- 部分影片容器或編碼無法由瀏覽器解碼；遇到錯誤時可先轉成 MP4/H.264 + AAC，或 WAV/MP3。

## 授權

移植程式依原專案 MIT 授權，見 [DEMucs-WEB-LICENSE](./DEMucs-WEB-LICENSE)。
