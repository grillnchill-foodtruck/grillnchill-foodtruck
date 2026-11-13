#!/usr/bin/env python3
"""
werkzeug/i18n-auszeichnen.py
----------------------------------------------------------------------------
Versieht die Texte einer Unterseite mit Übersetzungsschlüsseln, so wie
/firmen es von Hand hat:

  data-i18n="halal.t01"         reiner Text
  data-i18n-html="halal.t02"    Text mit Links, <strong>, &nbsp; usw.
  data-i18n-alt / -placeholder / -aria   für Bildtexte, Platzhalter, Labels

  python3 werkzeug/i18n-auszeichnen.py halal.html halal  > neu.json

Das Werkzeug fügt nur Attribute oder <span>-Hüllen ein und lässt den Rest der
Datei Zeichen für Zeichen stehen (Skripte, Hashes, Einrückung). Es gibt die
deutschen Texte als JSON aus: { schluessel: { "de": "…", "html": bool } }.

Ausgelassen werden:
- Bereiche zwischen Build-Markern (SEITENKOPF, FAKTEN, ZONEN, RADIUS, PREISE):
  die schreibt werkzeug/seiten-bauen.js mit eigenen Schlüsseln
- Elemente, die schon einen Schlüssel haben
- Elemente, deren Text ein Skript selbst setzt (--js datei.js: Ids mit
  .textContent/.innerHTML), und Teilbäume mit Klasse aus --ohne
- Telefon-, Mail- und reine Zahlen-/Code-Texte
FAQ: <summary> und <p> direkt in <details> bekommen eine <span>-Hülle, weil
faqDaten() in seiten-bauen.js die nackten Tags erwartet.
----------------------------------------------------------------------------
"""
import json
import re
import sys
from html.parser import HTMLParser

INLINE = {'a', 'strong', 'b', 'em', 'i', 'small', 'br', 'span', 'abbr', 'sup', 'sub', 'code', 's', 'u', 'mark', 'time', 'wbr'}
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'}
ROH = {'script', 'style', 'svg', 'template', 'textarea'}
MARKER = ['SEITENKOPF', 'FAKTEN', 'ZONEN', 'RADIUS', 'PREISE']


class Knoten:
    def __init__(self, tag, attrs, start, start_ende):
        self.tag, self.attrs = tag, dict(attrs)
        self.start, self.start_ende = start, start_ende   # Offsets des Start-Tags
        self.ende_start = self.ende = None                  # Offsets des End-Tags
        self.kinder = []                                    # Knoten oder ('text', a, b)
        self.eltern = None


class Baum(HTMLParser):
    def __init__(self, quelle):
        super().__init__(convert_charrefs=False)
        self.q = quelle
        zeilen = quelle.split('\n')
        self.zeilen_start, n = [], 0
        for z in zeilen:
            self.zeilen_start.append(n)
            n += len(z) + 1
        self.wurzel = Knoten('#root', [], 0, 0)
        self.stapel = [self.wurzel]

    def pos(self):
        z, s = self.getpos()
        return self.zeilen_start[z - 1] + s

    def handle_starttag(self, tag, attrs):
        a = self.pos()
        b = a + len(self.get_starttag_text())
        k = Knoten(tag, attrs, a, b)
        k.eltern = self.stapel[-1]
        self.stapel[-1].kinder.append(k)
        if tag in VOID:
            k.ende_start = k.ende = b
        else:
            self.stapel.append(k)

    def handle_startendtag(self, tag, attrs):
        a = self.pos()
        b = a + len(self.get_starttag_text())
        k = Knoten(tag, attrs, a, b)
        k.ende_start = k.ende = b
        k.eltern = self.stapel[-1]
        self.stapel[-1].kinder.append(k)

    def handle_endtag(self, tag):
        a = self.pos()
        b = self.q.index('>', a) + 1
        for i in range(len(self.stapel) - 1, 0, -1):
            if self.stapel[i].tag == tag:
                for k in self.stapel[i:]:
                    if k.ende is None:
                        k.ende_start, k.ende = a, b
                del self.stapel[i:]
                break

    def _text(self, laenge):
        a = self.pos()
        self.stapel[-1].kinder.append(('text', a, a + laenge))

    def handle_data(self, d):
        self._text(len(d))

    def handle_entityref(self, name):
        self._text(len(name) + 2)

    def handle_charref(self, name):
        self._text(len(name) + 3)


def main():
    datei, praefix = sys.argv[1], sys.argv[2]
    js_dateien, ohne_klassen, ohne_ids = [], set(), set()
    args = sys.argv[3:]
    while args:
        k = args.pop(0)
        if k == '--js':
            js_dateien.append(args.pop(0))
        elif k == '--ohne':
            ohne_klassen.update(args.pop(0).split(','))
        elif k == '--ohne-id':
            ohne_ids.update(args.pop(0).split(','))
    q = open(datei, encoding='utf-8').read()
    for f in js_dateien:
        js = open(f, encoding='utf-8').read()
        ohne_ids.update(re.findall(r"""\$\(['"]([\w-]+)['"]\)\.(?:textContent|innerHTML)""", js))
        ohne_ids.update(re.findall(r"""getElementById\(['"]([\w-]+)['"]\)\.(?:textContent|innerHTML)""", js))

    # Gesperrte Bereiche: Build-Marker
    gesperrt = []
    for m in MARKER:
        for a in re.finditer(r'<!-- ' + m + r':START', q):
            e = q.index('<!-- ' + m + ':ENDE -->', a.start())
            gesperrt.append((a.start(), e))

    baum = Baum(q)
    baum.feed(q)

    def gesperrt_bei(o):
        return any(a <= o < e for a, e in gesperrt)

    def roh_text(k):
        return q[k[1]:k[2]]

    def innen(k):
        return q[k.start_ende:k.ende_start]

    def sichtbarer_text(k):
        s = re.sub(r'<[^>]+>', '', innen(k))
        s = s.replace('&nbsp;', ' ').replace('&amp;', '&')
        return re.sub(r'\s+', ' ', s).strip()

    def nur_inline(k):
        for c in k.kinder:
            if isinstance(c, tuple):
                continue
            if c.tag not in INLINE or 'data-i18n' in c.attrs or 'data-i18n-html' in c.attrs:
                return False
            if c.attrs.get('id') in ohne_ids:
                return False
            if not nur_inline(c):
                return False
        return True

    def lohnt(text):
        if 'GbR' in text or not re.search(r'[A-Za-zÄÖÜäöüß]{2,}', text):
            return False                       # nur Zahlen, Preise, Codes
        if re.fullmatch(r'[\d\s+()/.,·€–-]+|GNC[•\w]*|HCG\d+', text):
            return False
        return True

    schluessel = {}
    edits = []      # (offset, einzufuegender_text)
    zaehler = [0]

    def neuer_key():
        zaehler[0] += 1
        return '%s.t%02d' % (praefix, zaehler[0])

    def attr_einfuegen(k, name, key):
        # direkt vor dem schließenden '>' bzw. '/>' des Start-Tags
        st = q[k.start:k.start_ende]
        off = k.start_ende - (2 if st.endswith('/>') else 1)
        edits.append((off, ' %s="%s"' % (name, key)))

    def text_eintragen(k, html):
        key = neuer_key()
        inhalt = innen(k).strip()
        if html:
            schluessel[key] = {'de': re.sub(r'\s*\n\s*', ' ', inhalt), 'html': True}
        else:
            schluessel[key] = {'de': sichtbarer_text(k), 'html': False}
        return key

    def ist_html(k):
        inh = innen(k)
        return bool(re.search(r'<|&\w+;|&#', inh))

    def ausgeschlossen(k):
        if k.tag in ROH or gesperrt_bei(k.start):
            return True
        if k.attrs.get('id') in ohne_ids:
            return True
        if ohne_klassen & set((k.attrs.get('class') or '').split()):
            return True
        if any(a in k.attrs for a in ('data-i18n', 'data-i18n-html')):
            return True
        href = k.attrs.get('href') or ''
        if href.startswith('tel:') or href.startswith('mailto:'):
            return True
        return False

    def attribute(k):
        if gesperrt_bei(k.start):
            return
        if k.tag == 'img' and k.attrs.get('alt') and 'data-i18n-alt' not in k.attrs and lohnt(k.attrs['alt']):
            key = neuer_key()
            schluessel[key] = {'de': k.attrs['alt'], 'html': False}
            attr_einfuegen(k, 'data-i18n-alt', key)
        if k.tag in ('input', 'textarea') and k.attrs.get('placeholder') and 'data-i18n-placeholder' not in k.attrs:
            ph = k.attrs['placeholder']
            if lohnt(ph) and '@' not in ph:
                key = neuer_key()
                schluessel[key] = {'de': ph, 'html': False}
                attr_einfuegen(k, 'data-i18n-placeholder', key)
        if k.attrs.get('aria-label') and 'data-i18n-aria' not in k.attrs and lohnt(k.attrs['aria-label']):
            key = neuer_key()
            schluessel[key] = {'de': k.attrs['aria-label'], 'html': False}
            attr_einfuegen(k, 'data-i18n-aria', key)

    def huelle(a, b, html, de):
        key = neuer_key()
        schluessel[key] = {'de': de, 'html': html}
        edits.append((a, '<span %s="%s">' % ('data-i18n-html' if html else 'data-i18n', key)))
        edits.append((b, '</span>'))

    def besuchen(k):
        if not isinstance(k, Knoten):
            return
        if ausgeschlossen(k):
            return
        attribute(k)
        # FAQ: summary/p direkt in details bekommen eine Hülle
        if k.tag in ('summary', 'p') and k.eltern is not None and k.eltern.tag == 'details' and nur_inline(k):
            text = sichtbarer_text(k)
            if lohnt(text):
                inh = innen(k)
                a = k.start_ende + (len(inh) - len(inh.lstrip()))
                b = k.ende_start - (len(inh) - len(inh.rstrip()))
                if '<!--' not in inh:
                    huelle(a, b, ist_html(k), re.sub(r'\s*\n\s*', ' ', q[a:b]) if ist_html(k) else text)
            return
        direkter_text = any(isinstance(c, tuple) and roh_text(c).strip() for c in k.kinder)
        mehrere = sum(1 for c in k.kinder if isinstance(c, Knoten)) >= 2
        # Behälter ohne eigenen Text (z. B. zwei Knöpfe nebeneinander): einzeln auszeichnen
        als_ganzes = direkter_text or not mehrere or k.tag in ('p', 'li', 'dd', 'dt', 'h1', 'h2', 'h3', 'h4', 'label', 'small')
        if als_ganzes and k.tag != '#root' and k.tag not in ('main', 'footer', 'body', 'title') and nur_inline(k) and k.ende_start is not None:
            text = sichtbarer_text(k)
            if text and lohnt(text):
                if '<!--' in innen(k):
                    return
                html = ist_html(k)
                key = text_eintragen(k, html)
                attr_einfuegen(k, 'data-i18n-html' if html else 'data-i18n', key)
            return
        # Gemischter Inhalt (Text neben Blöcken oder SVG): Textstücke einzeln hüllen
        for c in k.kinder:
            if isinstance(c, tuple):
                roh = roh_text(c)
                if roh.strip() and lohnt(roh.strip()) and not gesperrt_bei(c[1]) and k.tag not in ROH:
                    lead = len(roh) - len(roh.lstrip())
                    trail = len(roh) - len(roh.rstrip())
                    huelle(c[1] + lead, c[2] - trail, False, re.sub(r'\s+', ' ', roh.strip()))
            else:
                besuchen(c)

    # Nur <main> und <footer> (der Kopf hat eigene Schlüssel)
    def finde(k, tags, out):
        for c in k.kinder:
            if isinstance(c, Knoten):
                if c.tag in tags:
                    out.append(c)
                else:
                    finde(c, tags, out)
        return out

    for bereich in finde(baum.wurzel, {'main', 'footer'}, []):
        for c in bereich.kinder:
            besuchen(c)

    # Seitentitel
    titel = finde(baum.wurzel, {'title'}, [])
    if titel and 'data-i18n' not in titel[0].attrs:
        key = '%s.titel' % praefix
        schluessel[key] = {'de': sichtbarer_text(titel[0]), 'html': False}
        attr_einfuegen(titel[0], 'data-i18n', key)

    for off, text in sorted(edits, key=lambda e: e[0], reverse=True):
        q = q[:off] + text + q[off:]
    ziel = datei if '--trocken' not in sys.argv else datei + '.trocken'
    open(ziel, 'w', encoding='utf-8').write(q)
    json.dump(schluessel, sys.stdout, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
