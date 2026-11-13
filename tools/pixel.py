"""Gera a pixel art do BAGRENATION a partir de desenhos em texto.

Uso: python tools/pixel.py   (reescreve os blocos marcados em index.html e style.css, e o favicon.svg)
Cada ícone é uma grade 16x16 ('#' = pixel aceso). O mascote usa uma letra por cor.
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent

ICONS = {
    "cast": """
................
.##############.
.#............#.
.#......#.....#.
.#.....###....#.
.#....#####...#.
.#......#.....#.
.#......#.....#.
.#............#.
.##############.
................
.....######.....
.......##.......
.....######.....
................
................""",
    "stop": """
................
.##############.
.#............#.
.#............#.
.#....####....#.
.#....####....#.
.#....####....#.
.#....####....#.
.#............#.
.##############.
................
.....######.....
.......##.......
.....######.....
................
................""",
    "vol": """
................
.......#........
......##.....#..
.....###..#...#.
.#######...#..#.
.#######...#..#.
.#######...#..#.
.#######...#..#.
.#######...#..#.
.#######...#..#.
.....###..#...#.
......##.....#..
.......#........
................
................
................""",
    "mute": """
................
.......#........
......##........
.....###........
.#######........
.#######.#...#..
.#######..#.#...
.#######...#....
.#######..#.#...
.#######.#...#..
.....###........
......##........
.......#........
................
................
................""",
    "copy": """
................
.#########......
.#.......#......
.#.......#......
.#....#########.
.#....#.......#.
.#....#.......#.
.#....#.......#.
.#....#.......#.
.######.......#.
......#.......#.
......#.......#.
......#########.
................
................
................""",
    "check": """
................
................
..............#.
.............##.
............##..
...........##...
.#........##....
.##......##.....
..##....##......
...##..##.......
....####........
.....##.........
................
................
................
................""",
    "people": """
................
....###.........
...#####...##...
...#####..####..
...#####..####..
....###....##...
................
..#######.####..
.#########.####.
.#########.####.
.#########.####.
................
................
................
................
................""",
    "full": """
................
.#####....#####.
.#............#.
.#............#.
.#............#.
.#............#.
................
................
................
................
.#............#.
.#............#.
.#............#.
.#............#.
.#####....#####.
................""",
    "pip": """
................
.##############.
.#............#.
.#............#.
.#............#.
.#............#.
.#.....######.#.
.#.....######.#.
.#.....######.#.
.#.....######.#.
.#............#.
.##############.
................
................
................
................""",
    "focus": """
................
.##############.
.#............#.
.#............#.
.#............#.
.#............#.
.#............#.
.#............#.
.##############.
................
.###..####..###.
.###..####..###.
................
................
................
................""",
    "leave": """
................
................
................
....########....
..############..
.###..####..###.
.##....##....##.
.##..........##.
.####......####.
.####......####.
................
................
................
................
................
................""",
    "close": """
................
................
..##........##..
...##......##...
....##....##....
.....##..##.....
......####......
.......##.......
......####......
.....##..##.....
....##....##....
...##......##...
..##........##..
................
................
................""",
    "send": """
................
.##.............
.####...........
.######.........
..#######.......
..#########.....
...##########...
...############.
...##########...
..#########.....
..#######.......
.######.........
.####...........
.##.............
................
................""",
    "eye": """
................
................
................
.....######.....
...##......##...
..#....##....#..
.#....####....#.
.#....####....#.
..#....##....#..
...##......##...
.....######.....
................
................
................
................
................""",
    "swap": """
................
..........#.....
..........##....
.#############..
..........##....
..........#.....
................
................
.....#..........
....##..........
..#############.
....##..........
.....#..........
................
................
................""",
    "sliders": """
................
.........##.....
.#######.##.###.
.#######.##.###.
.........##.....
................
................
.....##.........
.###.##.#######.
.###.##.#######.
.....##.........
................
................
................
................
................""",
    "headset": """
................
.....######.....
...##......##...
..#..........#..
.#............#.
.#............#.
.#............#.
.####......####.
.####......####.
.####......####.
.####......####.
.####......####.
................
................
................
................""",
    "headset-off": """
...............#
.....######...#.
...##......##...
..#.........#...
.#.........#..#.
.#........#...#.
.#.......#....#.
.####...#..####.
.####..#...####.
.####.#....####.
.####......####.
.#####.....####.
#...............
................
................
................""",
    "help": """
................
.....######.....
....##....##....
....##....##....
..........##....
.........##.....
........##......
.......##.......
.......##.......
................
.......##.......
.......##.......
................
................
................
................""",
    "enter": """
................
.........######.
.........#....#.
.....#...#....#.
.....##..#....#.
.#########....#.
.#########....#.
.....##..#....#.
.....#...#....#.
.........#....#.
.........######.
................
................
................
................
................""",
    "arrow": """
................
................
................
.........#......
.........##.....
.........###....
.############...
.#############..
.############...
.........###....
.........##.....
.........#......
................
................
................
................""",
    "plus": """
................
................
......###.......
......###.......
......###.......
.#############..
.#############..
.#############..
......###.......
......###.......
......###.......
................
................
................
................
................""",
    "chat": """
................
.##############.
.#............#.
.#..##.##.##..#.
.#............#.
.#............#.
.######.#######.
......#.#.......
......##........
......#.........
................
................
................
................
................
................""",
    "coin": """
................
.....######.....
...##......##...
..#...####...#..
..#..##..##..#..
.#...##.......#.
.#...##.......#.
.#...##..##...#.
..#...####...#..
..#..........#..
...##......##...
.....######.....
................
................
................
................""",
    "mic": """
................
......####......
.....######.....
.....######.....
.....######.....
.....######.....
.....######.....
...#.######.#...
...#..####..#...
....#......#....
.....######.....
.......##.......
.......##.......
.....######.....
................
................""",
    "mic-off": """
..............#.
......####...#..
.....######.#...
.....#####.#....
.....####.#.....
.....###.#.#....
.....##.#.##....
...#.#.#.###.#..
...#..#.###..#..
....##.....#....
....#.#####.....
...#...##.......
..#....##.......
.#...######.....
................
................""",
    "gear": """
................
......####......
..##..####..##..
..############..
...##########...
.####......####.
.###........###.
.###...##...###.
.###...##...###.
.###........###.
.####......####.
...##########...
..############..
..##..####..##..
......####......
................""",
    "chat-off": """
...............#
.############.#.
.#..........#...
.#..##.##..#..#.
.#........#...#.
.#.......#....#.
.######.#.#####.
......##........
.....###........
....#.#.........
...#............
..#.............
.#..............
................
................
................""",
    "pencil": """
................
...........##...
..........####..
.........##.##..
........##.##...
.......##.##....
......##.##.....
.....##.##......
....##.##.......
...#.###........
...#..#.........
..####..........
................
................
................
................""",
}

# Mascote: bagre cyberpunk de perfil, olhando para a direita. Dois quadros de idle.
PAL = {
    "K": "#07040f",  # contorno
    "B": "#13b5c9",  # corpo
    "D": "#0b6c80",  # sombra do corpo
    "H": "#7ef4ff",  # brilho
    "L": "#d8fbff",  # barriga
    "F": "#ff2bd6",  # nadadeiras
    "G": "#8c1478",  # nadadeira escura
    "V": "#ffe600",  # viseira
    "W": "#fffbd0",  # reflexo da viseira
    "Y": "#ffe600",  # barbilhões
    "C": "#00f0ff",  # circuito
    "R": "#ff3355",  # led
    # cores extras dos avatares
    "N": "#39ff88", "n": "#168a4a", "O": "#ff8a1f", "P": "#9b6dff", "p": "#2a2160",
    "S": "#f2b58a", "T": "#f4f0ff", "E": "#a9a2d6", "e": "#4a4470",
    "M": "#8a5230", "m": "#4f2c18", "r": "#a3122e", "b": "#2b4bd6",
}
BAGRE = ["""
........................................
.................KK.............R.......
................KFFK............K.......
...............KFFFFK...........K.......
..............KFGFFFFK.....KKKKKKKK.....
...KK........KKKKKKKKKKKKKKBBBBBBBBKK...
..KFFK.....KKBBBBBBBBBBBBBBBBHHHBBBBBK..
..KFFFK..KKBBBBBBBBBBCBBBBBKKKKKKKKKBBK.
..KFGFFKKBBBBBBBBBBBBCCCBBKVVVVVWWVVKBK.
...KFGFFBBBBDBBBBBBBBBBCBBKVVVVVVVVVKBK.
...KFGFFBBBBDDBBBBBBBBBBBBBKKKKKKKKKBBKY
..KFGFFKKBBBBDBBBBBBBBBBBBBBBBBBBBBBBKY.
..KFFFK..KKLLLLLLLLLLLLBBBBBBBBBKKKKKKYY
..KFFK.....KKLLLLLLLLLLLLLLLLLLLLLLLK..Y
...KK........KKKKFFKKKLLLLLLLLLLLLKKY...
................KFGFK.KKKKKKKKKKKKY.Y...
.................KFFK.........Y..Y..Y...
..................KK.........Y...Y......
............................Y....Y......
""", """
........................................
.................KK.....................
................KFFK............R.......
...............KFFFFK...........K.......
..............KFGFFFFK.....KKKKKKKK.....
.............KKKKKKKKKKKKKKBBBBBBBBKK...
...KK......KKBBBBBBBBBBBBBBBBHHHBBBBBK..
..KFFK...KKBBBBBBBBBBCBBBBBKKKKKKKKKBBK.
..KFFFK.KBBBBBBBBBBBBCCCBBKVVWWVVVVVKBK.
..KFGFFKBBBBDBBBBBBBBBBCBBKVVVVVVVVVKBK.
...KFGFFBBBBDDBBBBBBBBBBBBBKKKKKKKKKBBK.
...KFGFFKBBBBDBBBBBBBBBBBBBBBBBBBBBBBKYY
..KFGFFK.KKLLLLLLLLLLLLBBBBBBBBBKKKKKK.Y
..KFFFK....KKLLLLLLLLLLLLLLLLLLLLLLLKY..
..KFFK.......KKKKFFKKKLLLLLLLLLLLLKK.Y..
...KK............KFGK.KKKKKKKKKKKKY..Y..
.................KFFK..........Y..Y.....
..................KK...........Y..Y.....
...............................Y...Y....
"""]


def runs(grid, ch):
    """Retângulos horizontais de pixels com a letra ch (junta pixels vizinhos)."""
    out = []
    for y, row in enumerate(grid):
        for m in re.finditer(f"{re.escape(ch)}+", row):
            out.append(f"M{m.start()} {y}h{m.end() - m.start()}v1h-{m.end() - m.start()}z")
    return "".join(out)


def grid_of(art):
    return [r for r in art.strip("\n").split("\n")]


# Avatares 16x16. Desenho de 8 colunas = metade esquerda (espelhada); de 16 = inteiro.
# "." é o fundo do avatar (a cor que vem junto com o desenho).
HEAD = """
................
................
....KKKKKKKK....
..KKBBBBBBBBKK..
.KBBHHBBBBBBBBK.
.KBBBBKKKKKKKBK.
.KBBBKVVVVWWVKK.
.KBBBKVVVVVVVKK.
.KBBBBKKKKKKKBK.
.KLLLLBBBBBBBBK.
.KLLLLLLKKKKKKY.
..KKKKKKLLLLLKY.
.......KKKKKKY..
.........Y..Y...
........Y...Y...
................"""


def variant(swap, top=None, edits=()):
    """Bagre com outras cores (swap), topo redesenhado (2 linhas) e retoques (linha, coluna, texto)."""
    g = [r.translate(str.maketrans(swap)) for r in grid_of(HEAD)]
    if top:
        g[0:2] = top
    for y, x, txt in edits:
        g[y] = g[y][:x] + txt + g[y][x + len(txt):]
    return "\n".join(g)


def avatar_edit(art, edits):
    """Desenho espelhado + retoques assimétricos (linha, coluna, texto)."""
    g = [r + r[::-1] for r in grid_of(art)]
    for y, x, txt in edits:
        g[y] = g[y][:x] + txt + g[y][x + len(txt):]
    return "\n".join(g)


AVATARS = {
    "bagre": ("#ff2bd6", HEAD),
    "bagre-dj": ("#00f0ff", variant({"B": "F", "H": "T", "L": "T", "V": "p", "W": "C", "Y": "T"},
                                   edits=[(1, 3, "KKKKKKKKKK"), (2, 2, "KeeeeeeeeeeK"), (3, 1, "Ke"), (4, 0, "KeeK"),
                                          (5, 0, "KEeK"), (6, 0, "KEeK"), (7, 0, "KeeK"), (8, 1, "KK")])),
    "bagre-rei": ("#7b2dff", variant({"B": "V", "H": "W", "L": "W", "V": "R", "W": "T", "Y": "O"},
                                    top=["...O..OO..O.....", "...OOOOOOOO....."], edits=[(2, 3, "OROOOORO")])),
    "bagre-toxico": ("#1a1433", variant({"B": "N", "H": "T", "L": "T", "V": "F", "W": "T", "Y": "N"},
                                       top=["....F.F.F.F.....", "....FFFFFFFF...."])),
    "robo": ("#ffe600", """
.......R
.......E
..KKKKKK
.KEEEEEE
.KETEEEE
KKEKKKKK
KeEKCCKK
KeEKCCKK
KKEKKKKK
.KEEEEEE
.KEEKTKT
.KEEKKKK
.KEEEEEE
..KKKKKK
....Keee
...KKKKK"""),
    "caveira": ("#7b2dff", """
........
...KKKKK
..KTTTTT
.KTTTTTT
.KTTTTTT
.KTKKKTT
.KTKFKTT
.KTKKKTT
.KTTTTTK
..KTTTTK
..KETTTT
..KTKTKT
..KTKTKT
...KKKKK
........
........"""),
    "gato": ("#00f0ff", """
........
.KK.....
.KOK....
.KOOKKKK
.KOFOOOO
.KOOOOOO
KOOOOOOO
KOOKKOOO
KOONKOOO
KOOOOOOO
KOTTOOOF
KOTTTTTK
.KOTTTTT
..KOOOOO
...KKKKK
........"""),
    "alien": ("#2a0f33", """
........
....KKKK
..KKNNNN
.KNNNNNN
.KNTNNNN
KNNNNNNN
KNKKKNNN
KNKKKKNN
KNNKKKNN
KNNNNNNN
.KNNNNNN
.KNNNNnn
..KNNNKK
...KNNNN
....KKKK
........"""),
    "fantasma": ("#ff2bd6", """
........
....KKKK
..KKTTTT
.KTTTTTT
.KTTTTTT
KTTTTTTT
KTTKKTTT
KTTKKTTT
KTTTTTTT
KTTTTTKK
KTTTTTKK
KTTTTTTT
KTTTTTTT
KTTKTTTK
KTK.KTK.
.K...K.."""),
    "sapo": ("#ffe600", """
........
........
..KKKK..
.KTTTTK.
.KTKKTKK
.KTKKTNN
KKNTTNNN
KNNNNNNN
KNNNNNNN
KNNNNNNN
KNKNNNNN
KNNKKKKK
KNNNNNNN
.KNNLLLL
..KKKKKK
........"""),
    "polvo": ("#39ff88", """
........
....KKKK
..KKPPPP
.KPPPPPP
.KPTPPPP
KPPPPPPP
KPPTTPPP
KPPTKPPP
KPPPPPPP
KPPPPPKK
KPPPPPPP
.KPPPPPP
KPKPPKPP
KPKKPKKP
KPK.KPKK
.K...K.."""),
    "ninja": ("#00f0ff", """
........
....KKKK
..KKeeee
.Keeeeee
.KRRRRRR
KRRRRRRR
Keeeeeee
KeSSSSSS
KeSTKSSS
Keeeeeee
Keeeeeee
.Keeeeee
.Keeeeee
..KKeeee
....KKKK
........"""),
    "astronauta": ("#1a1433", """
........
....KKKK
..KKTTTT
.KTTTTTT
.KTKKKKK
KTKppppp
KTKpCCpp
KTKpCppp
KTKppppp
KTKppppp
KTTKKKKK
.KTTTTTT
.KETTTTT
..KKTTOO
....KKKK
........"""),
    "slime": ("#2a0f33", """
........
........
........
.....KKK
...KKCCC
..KCTCCC
.KCTCCCC
.KCCCCCC
KCCKKCCC
KCCKKCCC
KCCCCCCC
KCCCCKCC
KCCCCCKK
KBCCCCCC
.KKKKKKK
........"""),
    "cogumelo": ("#39ff88", """
........
....KKKK
..KKRRRR
.KRRTTRR
KRRRTTRR
KTRRRRRR
KTTRRRRT
KRRRRRRT
.KKKKKKK
..KLLLLL
..KLKLLL
..KLKLLL
..KLLLLF
..KLLLLL
...KKKKK
........"""),

    # S-1180: originais no clima de RPG 16-bit, ação e cyberpunk (nenhum personagem de outra obra)
    "espadachim": ("#1a1433", """
........
..KK.KKK
.KNNKNNN
.KNNNNNN
KNNNNNNN
KVVVVVVV
KNSSSSSS
KNSTKSSS
KnSSSSSS
.KSSSSSS
.KSSSSKK
..KSSSSS
...KKKKK
..KbbbTT
.KbbbbbT
Kbbbbbbb"""),
    "maga": ("#00f0ff", """
.....KKK
...KKPPP
..KPPPPP
.KPPPPPV
.KPPPKKK
KPPPKFFF
KPPKFSSS
KPPKSTKS
KPPKSSSS
KPPKSSSS
KPPPKSSS
KPPPPKKK
.KPPPPPP
.KPpPPPp
KPPpPPPp
KPPPpPPP"""),
    "cavaleiro": ("#2a0f33", """
......RR
....KKRR
..KKEEKR
.KETEEEK
.KEEEEEE
KEEEEEEE
KEKKKKKE
KEKpTpKE
KEEEEEEE
KEEeEeEE
.KEeEeEE
.KEEEEEE
..KKEEEE
.KKeKKKK
KEEKeeee
KEEEKeee"""),
    "samurai": ("#ffe600", """
.O......
.OO...KK
..OOKKRR
..KOORRR
.KRROOOO
KRRRRRRR
KKKKKKKK
KrSSSSSS
KrSTKSSS
KrSSSSSS
KrKSSSSS
KrrKSSKK
KrrrKKKK
.KrRrRrR
KRrRrRrR
KrRrRrRr"""),
    "cacador": ("#39ff88", """
........
....KKKK
...Keeee
...Keeee
...KOOOO
KKKKeeee
Keeeeeee
.KKKKKKK
..KSTKSS
..KSSSSS
.KKSSSKK
KpPKSSSS
KpPPKKKK
KpPPPpVp
KpPPPppp
KpPPPpVp"""),
    "alquimista": ("#7b2dff", avatar_edit("""
........
...KKKKK
.KKOOOOO
KOOOOOOO
KOKKKKKO
KOKCCTKM
KOKKKKKO
KOSSSSSS
KOSTKSSS
.KSSSSSS
.KSSSSKK
..KSSSSS
...KKKKK
..KMMMTT
.KMMMMMT
KMMMMMMM""", [(10, 12, "KTTK"), (11, 12, "KTTK"), (12, 11, "KNNNN"), (13, 11, "KNTNN"), (14, 11, "KNNNN"), (15, 11, "KKKKK")])),
    "bardo": ("#1a1433", avatar_edit("""
........
....KKKK
..KKNNNN
.KNNNNNN
KnnnnnNN
KKKKKKKK
KVVSSSSS
KVSTKSSS
KVSSSSSS
KVSSSSSS
.KSSSKKK
..KSSSSS
...KKKKK
..KFFFVV
.KFFFFFV
KFFFFFFF""", [(0, 13, "RR"), (1, 12, "RRr"), (2, 12, "Rr"), (3, 11, "r")])),
    "arqueira": ("#ff2bd6", """
........
....KKKK
..KKMMMM
.KMMMMMM
.KMMMMMM
.KNNNNNN
.KMMSSSS
KKMSSSSS
KSKSTKSS
.KKSSSSS
.KMSSSKK
.KMKSSSS
KMMMKKKK
KMMKnNNN
KMKnnnNN
KMKnnnnN"""),
    "chefao": ("#ff3355", """
K.......
KK......
KTK..KKK
KTTKKppp
.KTKpppp
.KKppppp
.Kpppppp
KppKKppp
KpppVKpp
Kppppppp
Kppppppp
.KppKKKK
.KpppTKT
..KKpppp
.KPPKKKK
KPPPPPKP"""),
    "dragao": ("#1a1433", """
........
.K....K.
KVK..KKK
KVVKKRRR
.KVRRRRR
.KRRRRRR
KRRRRRRR
KRRTKRRR
KRRKKRRR
KRRRRRRR
KRROOOOO
.KOOOKOO
.KOOOOOO
..KTOOOO
...KKKKK
........"""),
    "ninja-ciber": ("#ff2bd6", """
........
....KKKK
..KKpppp
.Kpppppp
.KppppCp
KpppppCC
KKKKKKKK
KCCCCTCC
KKKKKKKK
Kppppppp
KpFppppp
.Kpppppp
.KppFFpp
..KKpppp
.KeeKKKK
Keeeeeee"""),
    "netrunner": ("#1a1433", """
......KK
.....KFF
.....KFF
..KKKKFF
.KeeeKFF
KeeSSSSS
KKKKKKKK
KCCCTCCK
KKKKKKKK
.KSSSSSS
.KSSSSKK
..KSSSSS
...KKKKK
..KeeeNe
.KeeeeNe
KeeeeeNe"""),
    "mercenario": ("#ffe600", avatar_edit("""
........
....KKKK
..KKEEEE
.KEEEEEE
.KEsssss
KEsSSSSS
KsSKKSSS
KsSSKSSS
KsSSSSSS
.KSSSSSS
.KSMMMMM
..KMMKKM
...KKKKK
..KnnnKK
.Knnnnnn
Knnnnnnn""".replace("s", "S"), [(5, 11, "r"), (7, 11, "R"), (8, 11, "r"), (12, 11, "KKKKK"), (13, 11, "KEEEK"), (14, 11, "KECEK"), (15, 11, "KEEEK")])),
    "piloto": ("#00f0ff", """
........
....KKKK
..KKTTOO
.KTTTTOO
.KTTTTOO
KTKKKKKK
KTKpCCpp
KTKpCppp
KTKppppp
KEKKKKKK
KEKSSSSS
.KKSSSKK
..KSSSSS
..KKKKKK
.KOOKTTT
KOOOOKTT"""),
    "robo-antigo": ("#7b2dff", """
........
..NN.N..
.KKKKKKK
KMOOOOOO
KMOVOOOO
KMOOOKKK
KMOOKCCC
KMOOKCTC
KMOOKCCC
KMOOOKKK
KMOOOOOO
KMOKTKTK
KMOKKKKK
.KKKKKKK
..KmMMMM
.KKmMMMM"""),
    "viajante": ("#2a0f33", """
........
....KKKK
..KKMMMM
.KMMMMMM
.KMMMMMM
KMMKKKKM
KMKVVVVK
KMKVTKVK
KMKVVVVK
KMSKKKKS
.KSSSSKK
.KSSSSSS
..KKKKKK
.KCCCCCC
KCCCbCCC
KCCCCCCC"""),
}

# Abas da galeria (ordem = ordem das abas) e nomes inventados dos novos.
GROUPS = {
    "Bagres": ["bagre", "bagre-dj", "bagre-rei", "bagre-toxico"],
    "Clássicos": ["robo", "caveira", "gato", "alien", "fantasma", "sapo", "polvo", "ninja", "astronauta", "slime", "cogumelo"],
    "RPG": ["espadachim", "maga", "cavaleiro", "samurai", "cacador", "alquimista", "bardo", "arqueira", "chefao", "dragao"],
    "Cyber": ["ninja-ciber", "netrunner", "mercenario", "piloto", "robo-antigo", "viajante"],
}
NAMES = {
    "espadachim": "Tarvo, o espadachim", "maga": "Nyssara, a maga", "cavaleiro": "Brumal, o cavaleiro",
    "samurai": "Okiru, o samurai", "cacador": "Corvano, o caçador", "alquimista": "Zimbro, o alquimista",
    "bardo": "Lirão, o bardo", "arqueira": "Tílva, a arqueira", "chefao": "Umbraz, o chefão",
    "dragao": "Brasinha, o dragãozinho", "ninja-ciber": "Kiru-9, ninja ciber", "netrunner": "Vanta, a netrunner",
    "mercenario": "Rusgo, o mercenário", "piloto": "Tenê, piloto de mecha", "robo-antigo": "Ferrugem, o robô antigo",
    "viajante": "Ampulho, viajante do tempo",
}
assert sorted(sum(GROUPS.values(), [])) == sorted(AVATARS), "todo avatar em exatamente uma aba"
assert set(NAMES) <= set(AVATARS)


def avatar_grid(art):
    g = grid_of(art)
    if len(g[0]) == 8:
        g = [r + r[::-1] for r in g]
    assert len(g) == 16 and all(len(r) == 16 for r in g), art
    return g


def avatar_symbols():
    out = []
    group = {name: g for g, names in GROUPS.items() for name in names}
    for g_name in GROUPS:  # símbolos saem na ordem das abas
      for name in GROUPS[g_name]:
        bg, art = AVATARS[name]
        g = avatar_grid(art)
        body = "".join(f'<path fill="{PAL[c]}" d="{runs(g, c)}"/>' for c in PAL if any(c in r for r in g))
        label = f' data-n="{NAMES[name]}"' if name in NAMES else ""
        out.append(f'  <symbol id="av-{name}" data-g="{group[name]}"{label} viewBox="0 0 16 16"><path fill="{bg}" d="M0 0h16v16H0z"/>{body}</symbol>')
    return "\n".join(out)


def icon_symbols():
    syms = []
    for name, art in ICONS.items():
        g = grid_of(art)
        assert len(g) == 16 and all(len(r) == 16 for r in g), name
        syms.append(f'  <symbol id="i-{name}" viewBox="0 0 16 16"><path d="{runs(g, "#")}"/></symbol>')
    return "\n".join(syms + [favicon(symbol=True), avatar_symbols()])


def sprite_paths(art):
    g = grid_of(art)
    w = max(map(len, g))
    g = [r.ljust(w, ".") for r in g]
    return w, len(g), "".join(f'<path fill="{PAL[c]}" d="{runs(g, c)}"/>' for c in PAL if any(c in r for r in g))


def mascot():
    w, h, f1 = sprite_paths(BAGRE[0])
    _, _, f2 = sprite_paths(BAGRE[1])
    return (f'<svg class="bagre" viewBox="0 0 {w} {h}" width="{w * 6}" height="{h * 6}" shape-rendering="crispEdges" '
            f'aria-hidden="true" focusable="false"><g class="f1">{f1}</g><g class="f2">{f2}</g></svg>')


def favicon(symbol=False):
    head = """
................
................
....KKKKKKKK....
..KKBBBBBBBBKK..
.KBBHHBBBBBBBBK.
.KBBBBKKKKKKKBK.
.KBBBKVVVVWWVKK.
.KBBBKVVVVVVVKK.
.KBBBBKKKKKKKBK.
.KLLLLBBBBBBBBK.
.KLLLLLLKKKKKKY.
..KKKKKKLLLLLKY.
.......KKKKKKY..
.........Y..Y...
........Y...Y...
................"""
    g = grid_of(head)
    body = "".join(f'<path fill="{PAL[c]}" d="{runs(g, c)}"/>' for c in PAL if any(c in r for r in g))
    if symbol:
        return f'  <symbol id="mark" viewBox="0 0 16 16">{body}</symbol>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect width="16" height="16" fill="#0a0614"/>{body}</svg>\n'


# Molduras em degrau (9-slice). Grade 8x8: canto cortado em 2 degraus, borda de 1 pixel.
FRAME = """
..BBBB..
.BFFFFB.
BFFFFFFB
BFFFFFFB
BFFFFFFB
BFFFFFFB
.BFFFFB.
..BBBB..
"""
FRAMES = {  # nome: (borda, recheio)
    "panel": ("#3a2f73", "#0d0a1c"),
    "panel-hot": ("#00f0ff", "#0d0a1c"),
    "panel-mag": ("#ff2bd6", "#120a1e"),
    "field": ("#4a3f8a", "#05030b"),
    "field-hi": ("#7468c4", "#05030b"),
    "field-on": ("#00f0ff", "#05030b"),
    "field-bad": ("#ff3355", "#05030b"),
    "field-full": ("#ff2bd6", "#140a20"),
    "yellow": ("#fff6a8", "#ffe600"),
    "yellow-hi": ("#ffffff", "#fff27a"),
    "magenta": ("#ffb3f1", "#ff2bd6"),
    "cyan": ("#c4fbff", "#00f0ff"),
    "cyan-hi": ("#ffffff", "#8df8ff"),
    "magenta-hi": ("#ffffff", "#ff7de6"),
    "green": ("#d6ffe6", "#39ff88"),
    "red": ("#ffb3c0", "#ff3355"),
    "dark": ("#4a3f8a", "#1a1433"),
    "dark-hi": ("#00f0ff", "#221a44"),
    "dark-on": ("#ff2bd6", "#2a0f33"),
    "black": ("#ffffff22", "#07040fe6"),
}


def frames_css():
    g = grid_of(FRAME)
    lines = []
    for name, (b, f) in FRAMES.items():
        svg = (f"<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 8 8' shape-rendering='crispEdges'>"
               f"<path fill='{b}' d='{runs(g, 'B')}'/><path fill='{f}' d='{runs(g, 'F')}'/></svg>")
        uri = svg.replace("#", "%23").replace("<", "%3C").replace(">", "%3E")
        lines.append(f'  --fr-{name}: url("data:image/svg+xml,{uri}");')
    return ":root {\n" + "\n".join(lines) + "\n}"


def splice(path, start, end, body):
    text = path.read_text(encoding="utf-8")
    pat = re.compile(re.escape(start) + r".*?" + re.escape(end), re.S)
    assert pat.search(text), f"marcador ausente em {path.name}: {start}"
    path.write_text(pat.sub(lambda _: f"{start}\n{body}\n{end}", text), encoding="utf-8")


if __name__ == "__main__":
    html = ROOT / "index.html"
    splice(html, "<!-- PIXEL:ICONES -->", "<!-- /PIXEL:ICONES -->",
           '<svg class="sprite" aria-hidden="true" focusable="false">\n' + icon_symbols() + "\n</svg>")
    for tag in ("PIXEL:BAGRE", "PIXEL:BAGRE2", "PIXEL:BAGRE3"):
        if f"<!-- {tag} -->" in html.read_text(encoding="utf-8"):
            splice(html, f"<!-- {tag} -->", f"<!-- /{tag} -->", mascot())
    splice(ROOT / "style.css", "/* PIXEL:MOLDURAS */", "/* /PIXEL:MOLDURAS */", frames_css())
    (ROOT / "favicon.svg").write_text(favicon(), encoding="utf-8")
    print("ok: pixel art gerada")
