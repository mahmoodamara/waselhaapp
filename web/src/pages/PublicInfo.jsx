import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../components/UI.jsx';
import { privacyContent } from '../../../shared/privacyContent.js';
export default function PublicInfo({ page = 'privacy' }) {
  const { language, setLanguage } = useLanguage(), copy = privacyContent[language] ?? privacyContent.ar;
  const [type, setType] = useState(page === 'support' ? 'recovery' : 'deletion'), [identifier, setIdentifier] = useState(''), [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false), [reference, setReference] = useState(''), [failed, setFailed] = useState(false), [retention, setRetention] = useState(null);
  useEffect(() => { setType(page === 'support' ? 'recovery' : 'deletion'); setReference(''); setFailed(false); }, [page]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/public-info', { signal: controller.signal }).then(r => r.ok ? r.json() : null).then(data => setRetention(data?.locationRetentionSeconds)).catch(() => {});
    return () => controller.abort();
  }, []);
  async function submit(event) {
    event.preventDefault(); if (busy) return; setBusy(true); setFailed(false);
    try {
      const response = await fetch('/api/data-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, identifier, contact }) });
      if (!response.ok) throw Error();
      setReference((await response.json()).reference); setIdentifier(''); setContact('');
    } catch { setFailed(true); } finally { setBusy(false); }
  }
  return <main style={{ maxWidth: 760, margin: 'auto', padding: 24, lineHeight: 1.9 }} dir="rtl">
    <button className="quiet" onClick={() => setLanguage(language === 'he' ? 'ar' : 'he')}>العربية / עברית</button>
    <h1>{copy[page === 'data-request' ? 'request' : page]}</h1>
    <nav aria-label={copy.privacy} style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}><Link to="/privacy">{copy.privacy}</Link><Link to="/support">{copy.support}</Link><Link to="/data-request">{copy.request}</Link></nav>
    {page === 'privacy' ? <>
      {copy.paragraphs.map(text => <p key={text}>{text}</p>)}
      {retention && <p>{copy.retention} {copy.latest}: {retention.latest}؛ {copy.known}: {retention.known} (+{retention.geoSweepInterval})؛ {copy.baseline}: {retention.baseline}.</p>}
    </> : <>
      <p>{copy.supportHint}</p>
      {reference ? <p role="status">{copy.sent} <strong dir="ltr">{reference}</strong></p> : <form onSubmit={submit} style={{ display: 'grid', gap: 16 }}>
        <label>{copy.type}<select value={type} onChange={e => setType(e.target.value)}>{['recovery','access','deletion'].map(value => <option key={value} value={value}>{copy[value]}</option>)}</select></label>
        <label>{copy.identifier}<input required maxLength={80} autoComplete="username" value={identifier} onChange={e => setIdentifier(e.target.value)} /></label>
        <label>{copy.contact}<input required maxLength={160} dir="ltr" value={contact} onChange={e => setContact(e.target.value)} /></label>
        {failed && <p role="alert">{copy.failure}</p>}
        <button disabled={busy}>{busy ? '…' : copy.submit}</button>
      </form>}
    </>}
  </main>;
}
