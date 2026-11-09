# Earmark for your phone

Learn from recorded lectures by listening, explaining and recalling out loud. This version runs entirely on your phone: your lectures and progress are kept on the phone, and Gemini, with your own key, transcribes lectures, reads PDFs and notes aloud, picks chapters and terms, hears your spoken answers and checks your explanations. No PC or server is needed.

**Open it:** the address of this repository's GitHub Pages site, in Chrome on your phone. Then tap Chrome's **⋮** menu and choose **Install app**.

**First time:** in **Settings**, paste your Gemini key from aistudio.google.com and press **Test**. Then, in **Library**, choose a lecture recording (MP3 or M4A), or press **Add a PDF or notes** to have a PDF, Word, text or Markdown file read aloud by a Gemini voice. Keep Earmark open while it's prepared; if it's interrupted, it carries on from where it stopped.

**Your references:** in **Settings**, add textbook chapters or your own notes (PDF, Word, text or Markdown, up to 100 MB each). Gemini indexes them on your Gemini account. Then your explanations are checked against them as well as the lecture, terms the lecture doesn't define get definitions from them, and expert questions can compare them with the lecture. The source is always shown.

**Good to know:**
- Your lectures and progress live only in Chrome on this phone. Clearing Chrome's data for this site, or uninstalling the app, deletes them, so keep your original recordings and files.
- Listening and review work without internet. Transcribing, reading aloud and checking need it.
- What's sent, only to Gemini with your key: lecture audio in 3-minute pieces, transcripts, the text of PDFs and notes you have read aloud, your reference files and searches of them, your spoken answers, and your explanations with the part of the lecture they're about. On Gemini's free tier, Google may use what you send.
- PDFs are opened with pdf.js, Mozilla's PDF reader, which is loaded from cdn.jsdelivr.net when you add one. A scanned PDF holds pictures of pages, not text, so it can't be read aloud.

These files are made from the PC version of Earmark: `app.js` by its `build_phone_app.py`, from `web/app.js`.
