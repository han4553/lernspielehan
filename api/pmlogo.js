// Pixel-Marken – Logo-Proxy: holt die Handy-Logos von Wikimedia Commons und liefert sie
// von der eigenen Adresse aus (Cache am Vercel-Edge, kein Hotlinking durch die Schüler-Geräte).
const W = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/';
const MAP = {
  nokia: W + '0/02/Nokia_wordmark.svg/330px-Nokia_wordmark.svg.png',
  motorola: W + 'e/e5/Motorola_logo.svg/330px-Motorola_logo.svg.png',
  samsung: W + '6/61/Samsung_old_logo_before_year_2015.svg/330px-Samsung_old_logo_before_year_2015.svg.png',
  blackberry: W + '0/08/Blackberry_Logo_without_wordmark.svg/330px-Blackberry_Logo_without_wordmark.svg.png',
  sonyericsson: W + '2/29/Sony_Ericsson_wordmark.svg/330px-Sony_Ericsson_wordmark.svg.png',
  palm: W + 'f/f8/HP_Palm_Logo.svg/330px-HP_Palm_Logo.svg.png',
  lg: W + '2/20/LG_symbol.svg/330px-LG_symbol.svg.png',
  alcatel: W + 'e/e9/Alcatel_logo_2016.svg/330px-Alcatel_logo_2016.svg.png',
  apple: W + 'f/fa/Apple_logo_black.svg/330px-Apple_logo_black.svg.png',
  xiaomi: W + 'a/ae/Xiaomi_logo_%282021-%29.svg/330px-Xiaomi_logo_%282021-%29.svg.png',
  vivo: W + '2/29/Vivo_Logo.svg/330px-Vivo_Logo.svg.png',
  oppo: W + '0/0a/OPPO_LOGO_2019.svg/330px-OPPO_LOGO_2019.svg.png',
  realme: W + 'a/a2/Realme_logo.svg/330px-Realme_logo.svg.png',
  huawei: W + 'd/db/Huawei_wordmark_2019.svg/330px-Huawei_wordmark_2019.svg.png',
};
const UA = { 'User-Agent': 'Lernspiele-Klassenspiel/1.0 (https://lernspiele-eight.vercel.app)', Accept: 'image/png,image/*' };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const id = String((req.query && req.query.id) || '').toLowerCase();
  const url = Object.prototype.hasOwnProperty.call(MAP, id) ? MAP[id] : null;
  if (!url) return res.status(404).send('unbekanntes Logo');
  try {
    let x = await fetch(url, { headers: UA });
    if (!x.ok) x = await fetch(url.replace('thumb.wikimedia.org', 'upload.wikimedia.org'), { headers: UA });
    if (!x.ok) return res.status(502).send('Quelle antwortet mit ' + x.status);
    const buf = Buffer.from(await x.arrayBuffer());
    res.setHeader('Content-Type', x.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, stale-while-revalidate=86400');
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(502).send('Abruf fehlgeschlagen');
  }
};
module.exports.MAP = MAP;
