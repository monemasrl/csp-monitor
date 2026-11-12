const BOT_RE = /bot|crawler|spider|HeadlessChrome|Lighthouse|facebookexternalhit|curl|python-requests/i;

// Order matters: Edge and Chrome Android must be tested before Chrome; Safari needs Version/x.
const FAMILIES: Array<[string, RegExp]> = [
  ['Edge', /\bEdg(?:e|A|iOS)?\/(\d+)/],
  ['Firefox', /\b(?:Firefox|FxiOS)\/(\d+)/],
  ['Chrome Android', /\bAndroid\b.*\bChrome\/(\d+)/],
  ['Chrome', /\b(?:Chrome|CriOS)\/(\d+)/],
  ['Safari', /\bVersion\/(\d+)[^]*\bSafari\//],
];

export function reduceUa(ua: string | undefined): { label: string; isBot: boolean } {
  const s = ua ?? '';
  const isBot = BOT_RE.test(s);
  for (const [name, re] of FAMILIES) {
    const m = re.exec(s);
    if (m) return { label: `${name} ${m[1]}`, isBot };
  }
  return { label: 'Altro', isBot };
}
