"""
werkzeug/schrift-tuerkisch.py
----------------------------------------------------------------------------
Baut fonts/gnc-display-ext-400.woff2: die fuenf tuerkischen Buchstaben
I mit Punkt, S und s mit Cedille, G und g mit Breve im Stil der Ueberschriften-
Schrift Bowlby One.

Hintergrund: Bowlby One hat diese Buchstaben nicht, auch nicht in der vollen
Fassung von Google Fonts. Tuerkische Ueberschriften sprangen deshalb bei jedem
I, S und G mit Zeichen in eine Ersatzschrift (Mac: Impact, iPhone: SF). Und weil
"text-transform: uppercase" auf Tuerkisch aus jedem i ein I mit Punkt macht,
betraf das fast jedes Wort.

Die Buchstaben entstehen nur aus Teilen, die schon in Bowlby One stecken:
  I mit Punkt = I + ein Punkt aus I mit Trema (gleiche Hoehe wie dort)
  S/s mit Cedille = S/s + Cedille, so versetzt wie bei C/c mit Cedille
  G/g mit Breve = G/g + Breve, auf der Hoehe des Zirkumflex bei O bzw. a

Lizenz: Bowlby One (c) 2011 Vernon Adams, SIL Open Font License 1.1. "Bowlby"
ist ein reservierter Name; die abgeleitete Datei heisst deshalb anders
(GNC Display Ext). Copyright und Lizenz stehen in der Datei selbst.

Aufruf (braucht fontTools und brotli):
  python3 werkzeug/schrift-tuerkisch.py PFAD/BowlbyOne-Regular.ttf
Die volle TTF von Google Fonts liefert die Breve; alles andere kommt aus
fonts/bowlby-one-latin-400-normal.woff2, damit die Formen exakt passen.
"""
import os
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

HIER = os.path.dirname(os.path.abspath(__file__))
WOFF2 = os.path.join(HIER, '..', 'fonts', 'bowlby-one-latin-400-normal.woff2')
ZIEL = os.path.join(HIER, '..', 'fonts', 'gnc-display-ext-400.woff2')
NAME = 'GNC Display Ext'


def konturen(font, glyph):
    """Konturen eines Glyphen als Liste von Aufnahme-Listen (Komposita aufgeloest)."""
    gs = font.getGlyphSet()
    pen = DecomposingRecordingPen(gs)
    gs[glyph].draw(pen)
    alle, akt = [], []
    for op, args in pen.value:
        akt.append((op, args))
        if op in ('closePath', 'endPath'):
            alle.append(akt)
            akt = []
    return alle


def grenzen(kontur_liste):
    pen = BoundsPen(None)
    for k in kontur_liste:
        for op, args in k:
            getattr(pen, op)(*args)
    return pen.bounds


def zeichne(pen, kontur_liste, dx=0, dy=0):
    tp = TransformPen(pen, (1, 0, 0, 1, dx, dy))
    for k in kontur_liste:
        for op, args in k:
            getattr(tp, op)(*args)


def mitte(b):
    return (b[0] + b[2]) / 2


def main():
    if len(sys.argv) < 2:
        sys.exit('Pfad zur BowlbyOne-Regular.ttf fehlt (fuer die Breve).')
    font = TTFont(WOFF2)
    voll = TTFont(sys.argv[1])
    breve = konturen(voll, voll.getBestCmap()[0x02D8])

    # Punkt fuer das I: linker Punkt aus I mit Trema (Kontur ueber der Versalhoehe, breiter als 100 Einheiten)
    punkte = [k for k in konturen(font, 'Idieresis') if grenzen([k])[1] > 1500 and grenzen([k])[2] - grenzen([k])[0] > 100]
    punkt = [min(punkte, key=lambda k: grenzen([k])[0])]

    ced = konturen(font, 'cedilla')
    ced_b = grenzen(ced)
    b = lambda g: grenzen(konturen(font, g))
    # Versatz der Cedille gegenueber der Buchstabenmitte, wie in C und c mit Cedille
    ced_gross = 476 + mitte(ced_b) - mitte(b('C'))
    ced_klein = 457 + mitte(ced_b) - mitte(b('c'))
    # Hoehe des Zirkumflex ueber O (Versalien); bei a sitzt er auf 0
    akzent_gross = 283

    neu = {
        'Idotaccent': (0x0130, 'I', punkt, mitte(b('I')) - mitte(grenzen(punkt)), 0),
        'Scedilla': (0x015E, 'S', ced, mitte(b('S')) + ced_gross - mitte(ced_b), 0),
        'scedilla': (0x015F, 's', ced, mitte(b('s')) + ced_klein - mitte(ced_b), 0),
        'Gbreve': (0x011E, 'G', breve, mitte(b('G')) - mitte(grenzen(breve)), akzent_gross),
        'gbreve': (0x011F, 'g', breve, mitte(b('g')) - mitte(grenzen(breve)), 0),
    }

    glyf, hmtx = font['glyf'], font['hmtx']
    order = font.getGlyphOrder()
    for name, (cp, basis, teil, dx, dy) in neu.items():
        pen = TTGlyphPen(None)
        zeichne(pen, konturen(font, basis))
        zeichne(pen, teil, round(dx), dy)
        g = pen.glyph()
        g.recalcBounds(glyf)
        glyf[name] = g
        hmtx[name] = (hmtx[basis][0], g.xMin)
        if name not in order:
            order.append(name)
        for t in font['cmap'].tables:
            if t.isUnicode():
                t.cmap[cp] = name
    font.setGlyphOrder(order)

    opt = Options()
    opt.flavor = 'woff2'
    opt.name_IDs = [0, 13, 14]
    opt.layout_features = []
    opt.notdef_outline = True
    sub = Subsetter(opt)
    sub.populate(unicodes=[v[0] for v in neu.values()])
    sub.subset(font)

    nt = font['name']
    nt.names = [n for n in nt.names if n.nameID in (0, 13, 14)]
    for nid, txt in (
        (1, NAME), (2, 'Regular'), (3, NAME + ' Regular 1.0'), (4, NAME + ' Regular'),
        (5, 'Version 1.0; abgeleitet von Bowlby One 1.001'), (6, 'GNCDisplayExt-Regular'),
        (10, 'Tuerkische Buchstaben im Stil von Bowlby One (Vernon Adams), gebaut aus deren Teilen.'),
        (13, 'This Font Software is licensed under the SIL Open Font License, Version 1.1.'),
        (14, 'https://openfontlicense.org'),
    ):
        nt.setName(txt, nid, 3, 1, 0x409)
    font.flavor = 'woff2'
    font.save(ZIEL)
    print('geschrieben:', os.path.normpath(ZIEL), os.path.getsize(ZIEL), 'Bytes')


if __name__ == '__main__':
    main()
