import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useLanguage } from '../components/UI.jsx';
import { privacyContent } from '../../../shared/privacyContent.js';
export default function AdminDataRequests() {
  const { language } = useLanguage(), he = language === 'he';
  const copy = privacyContent[he ? 'he' : 'ar'];
  const statusLabel = { pending: he ? 'ממתינה' : 'قيد المراجعة', completed: he ? 'הושלמה' : 'مكتمل', rejected: he ? 'נדחתה' : 'مرفوض' };
  const loadVersion = useRef(0), reviewRef = useRef(null);
  const [data, setData] = useState({ items: [], nextCursor: null }), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const [selected, setSelected] = useState(null), [verified, setVerified] = useState(false), [userId, setUserId] = useState('');
  async function load(cursor) {
    const version = ++loadVersion.current;
    setBusy(true); setError(false);
    try { const page = await api(`/admin/data-requests${cursor ? `?cursor=${cursor}` : ''}`); if (version === loadVersion.current) setData(previous => cursor ? { ...page, items: [...previous.items, ...page.items] } : page); }
    catch { if (version === loadVersion.current) setError(true); } finally { if (version === loadVersion.current) setBusy(false); }
  }
  useEffect(() => { void load(); return () => { loadVersion.current++; }; }, []);
  useEffect(() => { if (selected) { reviewRef.current?.focus(); reviewRef.current?.scrollIntoView({ block:'nearest' }); } }, [selected?._id]);
  async function resolve(action) {
    if (busy) return; setBusy(true); setError(false);
    try { await api(`/admin/data-requests/${selected._id}/resolve`, { method: 'POST', body: { action, identityVerified: verified, ...(userId ? { userId } : {}) } }); setSelected(null); setVerified(false); setUserId(''); await load(); }
    catch { setError(true); } finally { setBusy(false); }
  }
  return <section className="panel">
    <h2>{he ? 'בקשות תמיכה ומידע' : 'طلبات الدعم والبيانات'}</h2>
    <p>{he ? 'יש לאמת זהות בערוץ רשום לפני חשיפת מידע או איפוס סיסמה. מחיקה מסירה את פרטי החשבון ושומרת רישומים כספיים.' : 'تحقق من الهوية عبر القناة المسجلة قبل إفصاح أو إعادة ضبط كلمة المرور. الحذف يزيل بيانات الحساب ويحفظ السجلات المالية.'}</p>
    {error && <p role="alert">{he ? 'הפעולה נכשלה. בדקו את הבקשה ונסו שוב.' : 'تعذرت العملية. راجع الطلب وحاول مجددًا.'}</p>}
    <button disabled={busy} onClick={() => load()}>{he ? 'רענון' : 'تحديث'}</button>
    {!busy && !data.items.length && <p>{he ? 'אין בקשות' : 'لا توجد طلبات'}</p>}
    {data.items.map(item => <article key={item._id} style={{ borderBottom: '1px solid #ddd', padding: 12 }}>
      <p><span dir="ltr">{item.reference}</span> · {copy[item.type] ?? '—'} · {statusLabel[item.status] ?? '—'}</p><p>{item.identifier} · {item.contact}</p>
      {item.status === 'pending' && <button disabled={busy} onClick={() => { setSelected(item); setVerified(false); setUserId(''); }}>{he ? 'בדיקת בקשה' : 'مراجعة الطلب'}</button>}
    </article>)}
    {selected && <div ref={reviewRef} tabIndex={-1} role="group" aria-label={selected.reference} style={{ padding: 16 }}>
      <p>{selected.reference}</p>
      <label><input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />{he ? 'הזהות אומתה בערוץ רשום' : 'تحققت من الهوية عبر قناة مسجلة'}</label>
      {selected.type === 'deletion' && <label>{he ? 'מזהה חשבון מאומת' : 'معرف الحساب المتحقق منه'}<input value={userId} onChange={e => setUserId(e.target.value)} maxLength={24} /></label>}
      <button disabled={busy || !verified || (selected.type === 'deletion' && !/^[a-f\d]{24}$/i.test(userId))} onClick={() => resolve('completed')}>{he ? 'השלמה לאחר טיפול' : 'إكمال بعد المعالجة'}</button>
      <button disabled={busy} onClick={() => resolve('rejected')}>{he ? 'דחיית בקשה' : 'رفض الطلب'}</button>
      <button onClick={() => setSelected(null)}>{he ? 'ביטול' : 'إلغاء'}</button>
    </div>}
    {data.nextCursor && <button disabled={busy} onClick={() => load(data.nextCursor)}>{he ? 'הבא' : 'التالي'}</button>}
  </section>;
}
