"use client";

export default function Home() {
  return (
    <main className="landing-page">
      <div className="ambient-glow ambient-glow-left" aria-hidden="true" />
      <div className="ambient-glow ambient-glow-right" aria-hidden="true" />

      <section className="welcome" aria-labelledby="albert-title">
        <p className="overline">YOUR PERSONAL AI</p>
        <h1 id="albert-title">Albert</h1>
        <p className="intro">How can I help you today?</p>

        <form
          className="chat-composer"
          action="#"
          onSubmit={(event) => event.preventDefault()}
        >
          <button
            className="attach-button"
            type="button"
            aria-label="Add an attachment"
          >
            <span aria-hidden="true">+</span>
          </button>
          <label className="sr-only" htmlFor="message">
            Message Albert
          </label>
          <textarea
            id="message"
            name="message"
            placeholder="Ask anything"
            rows={1}
          />
          <button className="send-button" type="submit" aria-label="Send message">
            <span aria-hidden="true">↗</span>
          </button>
        </form>

        <p className="disclaimer">Albert can make mistakes. Check important info.</p>
      </section>
    </main>
  );
}
