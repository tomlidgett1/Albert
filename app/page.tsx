"use client";

const apiTools = [
  { name: "Lightspeed", domain: "lightspeedhq.com" },
  { name: "Xero", domain: "xero.com" },
  { name: "Deputy", domain: "deputy.com" },
  { name: "Slack", domain: "slack.com" },
  { name: "Notion", domain: "notion.com" },
  { name: "Figma", domain: "figma.com" },
  { name: "Shopify", domain: "shopify.com" },
  { name: "HubSpot", domain: "hubspot.com" },
  { name: "Stripe", domain: "stripe.com" },
  { name: "Airtable", domain: "airtable.com" },
  { name: "Canva", domain: "canva.com" },
  { name: "Asana", domain: "asana.com" },
  { name: "Zoom", domain: "zoom.com" },
  { name: "Intercom", domain: "intercom.com" },
  { name: "Mailchimp", domain: "mailchimp.com" },
];

export default function Home() {
  return (
    <main className="landing-page">
      <div className="ambient-glow ambient-glow-left" aria-hidden="true" />
      <div className="ambient-glow ambient-glow-right" aria-hidden="true" />

      <nav className="site-nav" aria-label="Main navigation">
        <a className="nav-wordmark" href="#top" aria-label="Albert home">
          Albert<span aria-hidden="true">•</span>
        </a>
        <div className="nav-links">
          <a href="#overview">Overview</a>
          <a href="#connectors">Connectors</a>
          <a href="#security">Security</a>
        </div>
        <a className="nav-pill" href="#top">
          Start a conversation <span aria-hidden="true">↗</span>
        </a>
      </nav>

      <section className="hero" id="top" aria-labelledby="albert-title">
        <div className="hero-halo hero-halo-one" aria-hidden="true" />
        <div className="hero-halo hero-halo-two" aria-hidden="true" />
        <div className="welcome">
          <p className="hero-kicker">CONVERSATIONAL ANALYTICS</p>
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

          <p className="hero-note">Encrypted at rest and in transit</p>
        </div>
        <a className="scroll-cue" href="#overview">
          <span className="scroll-cue-line" aria-hidden="true" />
          Scroll to explore
          <span aria-hidden="true">↓</span>
        </a>
      </section>

      <section className="overview-section" id="overview" aria-labelledby="overview-title">
        <p className="section-eyebrow">ONE CONVERSATION. WHOLE BUSINESS.</p>
        <h2 id="overview-title">
          Every signal,
          <span> in focus.</span>
        </h2>
        <p className="section-lede">
          Albert connects the tools your team already uses and turns the noise
          into a clear next step.
        </p>
      </section>

      <section className="ecosystem-section" id="connectors" aria-labelledby="ecosystem-title">
        <div className="ecosystem-card">
          <div className="ecosystem-copy">
            <p className="section-eyebrow section-eyebrow-light">YOUR STACK, IN SYNC</p>
            <h2 id="ecosystem-title">
              Bring your<br />
              <span>whole world.</span>
            </h2>
            <p>
              Your sales, finance, people, and creative systems. Albert sees
              how they connect, so you do not have to.
            </p>
            <div className="ecosystem-meta">
              <span className="meta-dot" aria-hidden="true" />
              15 integrations ready
            </div>
          </div>

          <div className="badge-cloud" aria-label="Connected tools">
            <div className="cloud-puff cloud-puff-one" aria-hidden="true" />
            <div className="cloud-puff cloud-puff-two" aria-hidden="true" />
            {apiTools.map((tool, index) => (
              <span
                className={`connector-badge badge-${index + 1}`}
                key={tool.name}
                title={tool.name}
              >
                {/* Remote favicons are decorative and intentionally bypass image optimisation. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`https://www.google.com/s2/favicons?domain=${tool.domain}&sz=256`}
                  alt={`${tool.name} logo`}
                  width={42}
                  height={42}
                  loading="lazy"
                  decoding="async"
                />
              </span>
            ))}
            <p className="badge-cloud-note">and the tools you add next</p>
          </div>
        </div>
      </section>

      <section className="feature-section" id="security" aria-labelledby="feature-title">
        <div className="feature-heading">
          <p className="section-eyebrow">QUIETLY POWERFUL</p>
          <h2 id="feature-title">Simple on the surface.<br /><span>Serious underneath.</span></h2>
        </div>

        <div className="feature-grid">
          <article className="feature-card security-card">
            <div className="card-topline">
              <span>01</span>
              <span aria-hidden="true">⌁</span>
            </div>
            <div className="card-icon lock-icon" aria-hidden="true">⌁</div>
            <h3>Protected<br />at every step.</h3>
            <p>Encrypted at rest. Encrypted in transit. Your business stays yours.</p>
            <div className="security-rule" aria-hidden="true"><i /><i /><i /></div>
          </article>

          <article className="feature-card message-card" id="messages">
            <div className="card-topline">
              <span>02</span>
              <span aria-hidden="true">↗</span>
            </div>
            <p className="card-label">ALBERT IN MESSAGES</p>
            <h3>Ask from<br /><span>anywhere.</span></h3>
            <p>iMessage, voice, or web. The answer is always close.</p>
            <div className="message-preview" aria-hidden="true">
              <span>Revenue is up 18.4% this month.</span>
              <b>What changed?</b>
            </div>
          </article>

          <article className="feature-card agents-card" id="agents">
            <div className="card-topline">
              <span>03</span>
              <span aria-hidden="true">✦</span>
            </div>
            <p className="card-label">AGENTS</p>
            <h3>More than<br /><span>answers.</span></h3>
            <p>Agents watch, reason, and prepare the next move for you.</p>
            <div className="agent-orbit" aria-hidden="true">
              <span className="agent-orbit-core">A</span>
              <i className="agent-orbit-dot agent-orbit-dot-one" />
              <i className="agent-orbit-dot agent-orbit-dot-two" />
            </div>
          </article>
        </div>
      </section>

      <section className="closing-section" aria-labelledby="closing-title">
        <div className="closing-glow" aria-hidden="true" />
        <p className="section-eyebrow section-eyebrow-light">THE NEXT QUESTION</p>
        <h2 id="closing-title">Start with what<br /><span>you need to know.</span></h2>
        <a className="closing-button" href="#top">
          Talk to Albert <span aria-hidden="true">↗</span>
        </a>
      </section>

      <footer className="site-footer">
        <span className="footer-wordmark">Albert<span aria-hidden="true">•</span></span>
        <span>A local product demo</span>
        <a href="#top">Back to top ↑</a>
      </footer>
    </main>
  );
}
