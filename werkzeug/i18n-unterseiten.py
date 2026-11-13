#!/usr/bin/env python3
"""
werkzeug/i18n-unterseiten.py
----------------------------------------------------------------------------
Schreibt die Texte der Unterseiten (Halal, Liefergebiet, Catering, Gutscheine,
404) als eigenen Block in die Sprachdateien:

  i18n.js       Object.assign(I18N.de, { … })   nach const I18N = { … };
  i18n-xx.js    Object.assign(I18N.xx, { … })   am Dateiende

  python3 werkzeug/i18n-unterseiten.py <ordner>

<ordner> enthält de.json ({ schluessel: { "de": "…", "html": bool } }) und je
Sprache xx.json ({ schluessel: "…" }). Fehlt eine Sprachdatei, bleibt deren
Block unverändert. Der Block steht zwischen /* UNTERSEITEN:START */ und
/* UNTERSEITEN:ENDE */ und wird bei jedem Lauf ersetzt.

Danach sind die Blöcke die Quelle: Texte direkt dort ändern, in allen acht
Dateien gleichzeitig (Schlüssel siehe data-i18n in den Seiten).
----------------------------------------------------------------------------
"""
import json
import os
import re
import sys

WURZEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SPRACHEN = ['en', 'tr', 'it', 'es', 'pt', 'fr', 'nl']
START, ENDE = '/* UNTERSEITEN:START (werkzeug/i18n-unterseiten.py) */', '/* UNTERSEITEN:ENDE */'


def block(lang, werte):
    zeilen = ['  %s: %s,' % (json.dumps(k), json.dumps(v, ensure_ascii=False)) for k, v in werte.items()]
    return '%s\nObject.assign(I18N.%s, {\n%s\n});\n%s' % (START, lang, '\n'.join(zeilen), ENDE)


def ersetzen(text, neu, nach=None):
    rx = re.compile(re.escape(START) + r'[\s\S]*?' + re.escape(ENDE))
    if rx.search(text):
        return rx.sub(lambda m: neu, text, count=1)
    if nach is None:
        return text.rstrip('\n') + '\n\n' + neu + '\n'
    i = text.index(nach) + len(nach)
    return text[:i] + '\n\n' + neu + '\n' + text[i:]


def main():
    ordner = sys.argv[1]
    de = json.load(open(os.path.join(ordner, 'de.json'), encoding='utf-8'))
    p = os.path.join(WURZEL, 'i18n.js')
    t = open(p, encoding='utf-8').read()
    a = t.index('const I18N = {')
    ende = t.index('\n};\n', a) + 4          # Ende des Objekts mit dem deutschen Wörterbuch
    t = ersetzen(t, block('de', {k: v['de'] for k, v in de.items()}), nach=t[a:ende])
    open(p, 'w', encoding='utf-8').write(t)
    print('i18n.js: %d Schlüssel' % len(de))
    for lang in SPRACHEN:
        q = os.path.join(ordner, lang + '.json')
        if not os.path.exists(q):
            print('i18n-%s.js: übersprungen (keine %s.json)' % (lang, lang))
            continue
        werte = json.load(open(q, encoding='utf-8'))
        fehlend = [k for k in de if k not in werte]
        if fehlend:
            raise SystemExit('%s.json: fehlende Schlüssel %s' % (lang, fehlend[:5]))
        werte = {k: werte[k] for k in de}          # Reihenfolge wie Deutsch
        p = os.path.join(WURZEL, 'i18n-%s.js' % lang)
        t = open(p, encoding='utf-8').read()
        open(p, 'w', encoding='utf-8').write(ersetzen(t, block(lang, werte)))
        print('i18n-%s.js: %d Schlüssel' % (lang, len(werte)))


if __name__ == '__main__':
    main()
