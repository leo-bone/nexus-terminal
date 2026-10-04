#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Nexus Terminal — 美学宣传视频渲染器
====================================
把整个项目的核心逻辑「可视化模拟」成一段视频：
  · 因子关系网络：按类别分簇的节点 + 相关性连边（正=青、负=红）
  · 流动性：从「流动性核心」(LIQUIDITY / Fed BS) 喷射出发光粒子，沿边流入风险资产
  · 风险护栏：时间线从 GREEN(平静) → YELLOW(升温) → RED(承压) 演进，
              RED 时相关性收紧、流动性抽离、风险温度计（DVOL/FEAR/Credit）膨胀
  · HUD：标题、Nexus Score 量表、护栏状态、类别图例、随阶段变化的中文解说

渲染方式：纯 PIL/numpy 逐帧绘制 → 裸 RGB 帧经管道喂给内置 ffmpeg → libx264 MP4。
无需浏览器。

用法：
  python3 tools/make_nexus_video.py                # 渲染完整视频到 outputs/nexus_terminal.mp4
  python3 tools/make_nexus_video.py --preview 3    # 只渲染 3 帧到 /tmp 预览（不编码）
"""

import os, sys, math, random, subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageChops
import imageio_ffmpeg

# ----------------------------------------------------------------------------
# 基础配置
# ----------------------------------------------------------------------------
W, H = 1920, 1080
FPS = 30
DURATION = 21.0                      # 秒
N_FRAMES = int(DURATION * FPS)
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "outputs")
OUT_MP4 = os.path.join(OUT_DIR, "nexus_terminal.mp4")

CX, CY = 960, 480                   # 网络中心（略偏上，给底部 HUD 留空间）

random.seed(20261004)
np.random.seed(20261004)

# ----------------------------------------------------------------------------
# 颜色
# ----------------------------------------------------------------------------
def hex2rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

COL = {
    "LIQ":     "#FFC857",   # 流动性 / 金
    "CORE":    "#E2F5FF",   # BTC 核心 / 冷白
    "MACRO":   "#38BDF8",   # 宏观 / 青
    "ONCHAIN": "#FB923C",   # 链上 / 橙
    "DERIV":   "#E879F9",   # 衍生品 / 品红
    "COMMOD":  "#34D399",   # 大宗 / 绿
    "FX":      "#A78BFA",   # 外汇 / 紫
    "RISK":    "#FB7185",   # 信用/情绪 / 玫瑰
}
WHITE = (235, 244, 255)
DIM   = (150, 170, 195)

# ----------------------------------------------------------------------------
# 字体
# ----------------------------------------------------------------------------
SYS = "/System/Library/Fonts"
F_ARIAL_B   = os.path.join(SYS, "Supplemental", "Arial Bold.ttf")
F_ARIAL     = os.path.join(SYS, "Supplemental", "Arial.ttf")
F_PING      = os.path.join(SYS, "PingFang.ttc")     # 中文
F_PING_IDX  = 0

def font(path, size, idx=None):
    try:
        if idx is not None:
            return ImageFont.truetype(path, size, index=idx)
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()

F_TITLE   = font(F_ARIAL_B, 58)
F_SUB     = font(F_PING, 30, F_PING_IDX)
F_LABEL   = font(F_ARIAL, 22)
F_LABEL_S = font(F_ARIAL, 18)
F_HUD     = font(F_ARIAL_B, 26)
F_HUD_S   = font(F_ARIAL, 20)
F_CN      = font(F_PING, 30, F_PING_IDX)
F_CN_S    = font(F_PING, 24, F_PING_IDX)
F_CAP     = font(F_PING, 38, F_PING_IDX)
F_LEG     = font(F_PING, 20, F_PING_IDX)   # 图例中文专用（Arial 无 CJK）

# ----------------------------------------------------------------------------
# 节点 / 连边定义（模拟真实 Nexus Terminal 的因子分类）
# ----------------------------------------------------------------------------
# (id, 标签, 类别, 半径, x, y)
NODES = [
    ("LIQ",   "LIQUIDITY", "LIQ",     30, 960, 480),
    ("FEDBS", "Fed BS",    "LIQ",     18, 1130, 470),
    ("BTC",   "BTC",       "CORE",    40, 960, 250),
    ("ETH",   "ETH",       "ONCHAIN", 22, 760, 350),
    ("NVT",   "NVT",       "ONCHAIN", 14, 690, 250),
    ("MVRV",  "MVRV",      "ONCHAIN", 14, 690, 470),
    ("STBL",  "Stables",   "ONCHAIN", 16, 820, 600),
    ("DXY",   "DXY",       "MACRO",   18, 1500, 300),
    ("UST10", "UST 10Y",   "MACRO",   20, 1470, 470),
    ("T2S10", "2s10s",     "MACRO",   14, 1620, 560),
    ("REALY", "Real Yld",  "MACRO",   14, 1380, 650),
    ("CPI",   "CPI",       "MACRO",   14, 1650, 360),
    ("PCE",   "Core PCE",  "MACRO",   14, 1710, 480),
    ("UNEMP", "Unemp",     "MACRO",   14, 1560, 670),
    ("DVOL",  "DVOL",      "DERIV",   22, 560, 560),
    ("FUND",  "Funding",   "DERIV",   14, 640, 720),
    ("OI",    "Open Int",  "DERIV",   14, 470, 660),
    ("GOLD",  "Gold",      "COMMOD",  18, 360, 380),
    ("OIL",   "Oil",       "COMMOD",  16, 300, 580),
    ("HYG",   "Credit",    "RISK",    16, 720, 800),
    ("FEAR",  "Fear&Greed","RISK",16, 470, 430),
    ("USDJPY","USDJPY",    "FX",      14, 1180, 670),
    ("JGB",   "JGB",       "FX",      12, 1300, 760),
]
NODE = {n[0]: {"label": n[1], "cat": n[2], "r": n[3], "x": n[4], "y": n[5]} for n in NODES}
CAT_OF = {n[0]: n[2] for n in NODES}

# 连边：(a, b, 权重 0..1, 符号 +1/-1, 是否流动性通道 flow)
EDGES = [
    ("LIQ","BTC",0.95,+1,True),
    ("LIQ","ETH",0.80,+1,True),
    ("LIQ","STBL",0.70,+1,True),
    ("LIQ","GOLD",0.55,+1,True),
    ("LIQ","OIL",0.45,+1,True),
    ("LIQ","UST10",0.60,+1,True),
    ("LIQ","MVRV",0.50,+1,True),
    ("FEDBS","LIQ",0.85,+1,False),
    ("BTC","ETH",0.90,+1,False),
    ("BTC","NVT",0.55,-1,False),
    ("BTC","MVRV",0.65,+1,False),
    ("BTC","DVOL",0.70,-1,False),
    ("BTC","FUND",0.60,+1,False),
    ("BTC","OI",0.55,+1,False),
    ("BTC","FEAR",0.65,-1,False),
    ("BTC","GOLD",0.45,+1,False),
    ("UST10","DXY",0.75,+1,False),
    ("UST10","T2S10",0.70,+1,False),
    ("UST10","REALY",0.65,-1,False),
    ("UST10","GOLD",0.60,-1,False),
    ("UST10","BTC",0.55,-1,False),
    ("DXY","BTC",0.50,-1,False),
    ("DXY","GOLD",0.45,-1,False),
    ("OIL","CPI",0.60,+1,False),
    ("CPI","PCE",0.85,+1,False),
    ("UNEMP","UST10",0.50,-1,False),
    ("DVOL","FEAR",0.80,+1,False),
    ("HYG","BTC",0.55,-1,False),
    ("HYG","OIL",0.45,-1,False),
    ("USDJPY","DXY",0.65,+1,False),
    ("USDJPY","BTC",0.45,-1,False),
    ("JGB","UST10",0.60,+1,False),
    ("GOLD","BTC",0.40,+1,False),
]
FLOW_EDGES = [e for e in EDGES if e[4]]
EDGE_IDX = { (e[0],e[1]): i for i,e in enumerate(EDGES) }

# 每节点随机抖动相位（用于 agitation）
for k,v in NODE.items():
    v["ph"] = random.uniform(0, math.tau)
    v["fr"] = random.uniform(0.6, 1.4)

# ----------------------------------------------------------------------------
# 工具函数
# ----------------------------------------------------------------------------
def clamp(x, a, b):
    return max(a, min(b, x))

def smoothstep(a, b, x):
    t = clamp((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)

def lerp(a, b, t):
    return a + (b - a) * t

def lerp_col(c1, c2, t):
    return tuple(int(round(lerp(c1[i], c2[i], t))) for i in range(3))

def glow(radius, color, peak=1.0):
    r = max(2, int(radius))
    s = 2 * r
    yy, xx = np.mgrid[0:s, 0:s]
    d = np.sqrt((xx - r) ** 2 + (yy - r) ** 2)
    a = np.clip(1.0 - d / r, 0, 1)
    a = (a ** 1.9) * peak * 255
    img = np.zeros((s, s, 4), np.uint8)
    img[..., 0] = color[0]; img[..., 1] = color[1]; img[..., 2] = color[2]
    img[..., 3] = a.astype(np.uint8)
    return Image.fromarray(img, "RGBA")

# 预生成粒子发光精灵（不同尺寸），运行时着色用 ImageChops 不行，改为按色生成
def glow_sized(radius, color, peak=1.0):
    return glow(radius, color, peak)

# ----------------------------------------------------------------------------
# 背景（径向渐变 + 暗角），以及平静/承压两种底色混合
# ----------------------------------------------------------------------------
def build_bg():
    yy, xx = np.mgrid[0:H, 0:W]
    d = np.sqrt((xx - CX) ** 2 + (yy - CY) ** 2)
    dmax = math.sqrt(CX ** 2 + CY ** 2)
    g = 1.0 - (d / dmax) * 0.85
    g = np.clip(g, 0, 1) ** 1.3
    # 平静色：深青蓝
    top = np.array([10, 22, 34]); bot = np.array([4, 7, 13])
    base = top[None, None, :] * g[..., None] + bot[None, None, :] * (1 - g[..., None])
    img = np.zeros((H, W, 3), np.uint8)
    img[..., :] = base.astype(np.uint8)
    # 暗角
    vig = (g ** 2.2) * 255
    img = img.astype(np.float32)
    img[..., 0] *= (0.55 + 0.45 * vig / 255)
    img[..., 1] *= (0.55 + 0.45 * vig / 255)
    img[..., 2] *= (0.55 + 0.45 * vig / 255)
    return Image.fromarray(img.astype(np.uint8), "RGB").convert("RGBA")

BG = build_bg()
# 承压红晕（叠加用）
def build_red_tint():
    yy, xx = np.mgrid[0:H, 0:W]
    d = np.sqrt((xx - CX) ** 2 + (yy - CY) ** 2)
    dmax = math.sqrt(CX ** 2 + CY ** 2)
    g = np.clip(1.0 - d / dmax, 0, 1)
    a = (g ** 2.0) * 150
    img = np.zeros((H, W, 4), np.uint8)
    img[..., 0] = 120; img[..., 1] = 20; img[..., 2] = 28
    img[..., 3] = a.astype(np.uint8)
    return Image.fromarray(img, "RGBA")
RED_TINT = build_red_tint()

# ----------------------------------------------------------------------------
# 时间线 → 压力 s、流动性 L、护栏状态、分数、解说
# ----------------------------------------------------------------------------
def stress_at(t):       # t in [0,1]
    #  knots: 平静 → 升温 → 承压 → 持有红
    if t < 0.22:  return 0.0
    if t < 0.45:  return smoothstep(0.22, 0.45, t) * 0.40
    if t < 0.62:  return 0.40 + smoothstep(0.45, 0.62, t) * 0.30
    if t < 0.82:  return 0.70 + smoothstep(0.62, 0.82, t) * 0.30
    return 1.0

def liquidity_at(s):
    return clamp(1.0 - 0.66 * s, 0.24, 1.0)

def regime_at(s):
    if s < 0.34: return "GREEN"
    if s < 0.72: return "YELLOW"
    return "RED"

REG_COL = {"GREEN": (52, 211, 153), "YELLOW": (250, 204, 21), "RED": (248, 78, 78)}
REG_CN  = {"GREEN": "平静", "YELLOW": "升温", "RED": "承压"}

def caption_at(s):
    if s < 0.12:   return "因子关系网络 · 流动性自流动性核心注入风险资产"
    if s < 0.34:   return "多数因子温和 · 相关性分散 · 流动性充盈"
    if s < 0.55:   return "波动率与避险情绪抬升 · 相关性开始收紧"
    if s < 0.72:   return "风险温度计联动 · 多个类别同时偏离"
    if s < 0.90:   return "承压：相关性冲向一致 · 流动性抽离"
    return "RED · 建议降杠杆 / 不追高 / 避免临场决策"

# ----------------------------------------------------------------------------
# 几何：节点当前坐标（带抖动 + 整体缓慢呼吸旋转）
# ----------------------------------------------------------------------------
def node_pos(k, t, s, time):
    v = NODE[k]
    ax, ay = v["x"], v["y"]
    # 缓慢旋转（围绕中心）
    ang = 0.05 * math.sin(time * 0.12)
    dx, dy = ax - CX, ay - CY
    ca, sa = math.cos(ang), math.sin(ang)
    rx = dx * ca - dy * sa + CX
    ry = dx * sa + dy * ca + CY
    # 抖动：压力越大越躁动
    amp = 1.5 + 13.0 * s
    if k in ("LIQ", "BTC"):
        amp *= 0.4
    wob = amp * math.sin(time * v["fr"] * 1.3 + v["ph"])
    wob2 = amp * 0.7 * math.cos(time * v["fr"] * 0.9 + v["ph"] * 1.7)
    return rx + wob, ry + wob2

# 风险温度计节点（随压力膨胀）
def node_radius(k, s):
    v = NODE[k]
    base = v["r"]
    if k in ("DVOL", "FEAR", "HYG"):
        return base * (1.0 + 0.9 * s)
    if k == "LIQ":
        return base * (1.0 + 0.18 * math.sin(s * 6.0))   # 轻微脉动
    return base

# ----------------------------------------------------------------------------
# 粒子（流动性流）
# ----------------------------------------------------------------------------
class Particles:
    def __init__(self):
        self.items = []   # (edge_idx, p, speed, size)
    def spawn(self, rate):
        for _ in range(rate):
            ei = random.randrange(len(FLOW_EDGES))
            self.items.append([ei, 0.0, random.uniform(0.006, 0.013), random.uniform(6, 10)])
    def update(self, dt, L):
        keep = []
        for it in self.items:
            it[1] += it[2] * (0.5 + 0.7 * L)
            if it[1] < 1.0:
                keep.append(it)
        self.items = keep

def particle_pos(ei, p):
    e = FLOW_EDGES[ei]
    a, b = e[0], e[1]
    ax, ay = P_CACHE[a]; bx, by = P_CACHE[b]
    x = lerp(ax, bx, p); y = lerp(ay, by, p)
    # 垂直方向正弦摆动，更有机
    mx, my = bx - ax, by - ay
    L = math.hypot(mx, my) or 1
    nx, ny = -my / L, mx / L
    off = math.sin(p * math.pi * 2.0 + ei) * 7
    return x + nx * off, y + ny * off

# ----------------------------------------------------------------------------
# 绘制：连边（贝塞尔曲线）
# ----------------------------------------------------------------------------
def draw_edge(d, a, b, e, s, time):
    w, sign, flow = e[2], e[3], e[4]
    ax, ay = P_CACHE[a]; bx, by = P_CACHE[b]
    # 控制点：中点外推，制造轻微弧线
    mx, my = (ax + bx) / 2, (ay + by) / 2
    dx, dy = bx - ax, by - ay
    L = math.hypot(dx, dy) or 1
    nx, ny = -dy / L, dx / L
    bend = 0.12 * L
    cxp, cyp = mx + nx * bend, my + ny * bend
    # 颜色：正=类别色青蓝，负=红；承压时负向边更红更亮
    if sign > 0:
        col = hex2rgb(COL[CAT_OF[a]]) if CAT_OF[a] != "LIQ" else hex2rgb(COL["MACRO"])
        col = lerp_col(col, (120, 200, 255), 0.3)
    else:
        col = (255, 110, 110)
    inten = w * (0.35 + 0.45 * s)          # 承压更亮
    if sign < 0 and s > 0.5:
        inten = min(1.0, inten + (s - 0.5) * 0.8)
        col = lerp_col(col, (255, 70, 70), (s - 0.5) * 1.4)
    alpha = int(38 + 95 * inten)
    # 脉动
    alpha = int(alpha * (0.75 + 0.25 * math.sin(time * 1.6 + (ax + ay) * 0.01)))
    draw = ImageDraw.Draw(d)
    pts = []
    for i in range(17):
        tt = i / 16
        x = (1 - tt) ** 2 * ax + 2 * (1 - tt) * tt * cxp + tt ** 2 * bx
        y = (1 - tt) ** 2 * ay + 2 * (1 - tt) * tt * cyp + tt ** 2 * by
        pts.append((x, y))
    for i in range(len(pts) - 1):
        draw.line([pts[i], pts[i + 1]], fill=col + (alpha,), width=max(1, int(2 + 3 * w)))

# ----------------------------------------------------------------------------
# 绘制：节点
# ----------------------------------------------------------------------------
def draw_node(d, k, s, time):
    v = NODE[k]
    cat = v["cat"]
    col = hex2rgb(COL[cat]) if cat != "CORE" else hex2rgb(COL["CORE"])
    x, y = P_CACHE[k]
    r = node_radius(k, s)
    # 外晕
    halo_r = r * 2.9
    halo = glow(halo_r, col, peak=0.42 + 0.18 * s)
    d.alpha_composite(halo, (int(x - halo_r), int(y - halo_r)))
    # 核心
    draw = ImageDraw.Draw(d)
    draw.ellipse([x - r * 0.62, y - r * 0.62, x + r * 0.62, y + r * 0.62],
                 fill=col, outline=(255, 255, 255, 60))
    # 环
    draw.ellipse([x - r, y - r, x + r, y + r], outline=col + (200,), width=2)
    # 标签
    label = v["label"]
    f = F_LABEL if r >= 18 else F_LABEL_S
    tw = draw.textlength(label, font=f)
    draw.text((x - tw / 2, y + r + 4), label, font=f, fill=WHITE + (235,))
    if k == "BTC":
        bt = F_LABEL
        draw.text((x - draw.textlength("BTC · 核心资产", font=bt) / 2, y - r - 30),
                  "BTC · 核心资产", font=bt, fill=(226, 245, 255, 255))
    if k == "LIQ":
        draw.text((x - draw.textlength("流动性核心", font=F_CN_S) / 2, y - r - 30),
                  "流动性核心", font=F_CN_S, fill=(255, 200, 87, 255))

# ----------------------------------------------------------------------------
# HUD
# ----------------------------------------------------------------------------
def rounded_rect(d, box, radius, fill=None, outline=None, width=2):
    draw = ImageDraw.Draw(d)
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)

def draw_hud(d, s, time, frame):
    reg = regime_at(s)
    rcol = REG_COL[reg]
    L = liquidity_at(s)
    draw = ImageDraw.Draw(d)
    # 标题
    draw.text((70, 56), "NEXUS TERMINAL", font=F_TITLE, fill=(235, 244, 255, 255))
    draw.text((74, 124), "因子关系网络 · 流动性 · 风险护栏", font=F_SUB, fill=(150, 200, 235, 235))

    # 流动性仪表（左上，副标题下）
    gx0, gy0, gw, gh = 74, 186, 320, 18
    rounded_rect(d, (gx0, gy0, gx0 + gw, gy0 + gh), 9,
                 fill=(16, 22, 34, 200), outline=(120, 140, 165, 170), width=1)
    lcol = lerp_col((255, 200, 87), (255, 80, 80), 1 - L)
    rounded_rect(d, (gx0 + 2, gy0 + 2, gx0 + 2 + int((gw - 4) * L), gy0 + gh - 2), 7,
                 fill=lcol + (235,))
    draw.text((gx0 + gw + 14, gy0 - 6), f"LIQUIDITY {int(L*100)}%",
              font=F_HUD_S, fill=lcol + (255,))
    # 阶段药丸（右上）
    pill = (W - 360, 60, W - 70, 122)
    rounded_rect(d, pill, 18, fill=(20, 28, 40, 210), outline=rcol + (230,), width=3)
    draw.text((W - 340, 70), reg, font=F_HUD, fill=rcol + (255,))
    draw.text((W - 340, 92), REG_CN[reg], font=F_CN, fill=(220, 235, 255, 255))

    # 右侧护栏三段指示
    sx, sy, sw, sh = W - 232, 180, 150, 250
    rounded_rect(d, (sx - 6, sy - 6, sx + sw + 6, sy + sh + 6), 16,
                 fill=(16, 22, 34, 200), outline=(90, 110, 140, 160), width=2)
    segs = [("GREEN", 0), ("YELLOW", 1), ("RED", 2)]
    bh = sh / 3
    for i, (name, idx) in enumerate(segs):
        c = REG_COL[name]
        yy0 = sy + i * bh
        active = (name == reg)
        rounded_rect(d, (sx, yy0 + 8, sx + sw, yy0 + bh - 8), 12,
                     fill=c + (255 if active else 70,),
                     outline=c + (255,), width=2 if active else 1)
        if active:
            halo = glow(40, c, 0.5)
            d.alpha_composite(halo, (int(sx + sw / 2 - 40), int(yy0 + bh / 2 - 40)))
        draw.text((sx + 16, yy0 + bh / 2 - 14), name, font=F_LABEL,
                  fill=(10, 14, 20, 255) if active else (200, 215, 235, 180))

    # 底部：Nexus Score 量表
    score = 0.62 - 1.75 * s
    bx0, by0, bw, bh_ = 70, H - 150, 560, 26
    rounded_rect(d, (bx0, by0, bx0 + bw, by0 + bh_), 13,
                 fill=(16, 22, 34, 210), outline=(90, 110, 140, 170), width=2)
    # 中点
    mid = bx0 + bw / 2
    draw.line([(mid, by0 - 6), (mid, by0 + bh_ + 6)], fill=(120, 140, 165, 160), width=1)
    # 刻度 -2..+2
    for vv in (-2, -1, 0, 1, 2):
        xx = mid + (vv / 2) * (bw / 2)
        draw.line([(xx, by0 + bh_), (xx, by0 + bh_ + 6)], fill=(120, 140, 165, 160), width=1)
    # 当前值条
    sc = clamp(score / 2, -1, 1)
    if score >= 0:
        bar = (mid, by0 + 4, mid + sc * (bw / 2), by0 + bh_ - 4)
        bcol = (52, 211, 153)
    else:
        bar = (mid + sc * (bw / 2), by0 + 4, mid, by0 + bh_ - 4)
        bcol = (248, 78, 78)
    rounded_rect(d, bar, 9, fill=bcol + (235,))
    draw.text((bx0, by0 - 40), "NEXUS SCORE", font=F_HUD, fill=(220, 235, 255, 255))
    draw.text((bx0 + 250, by0 - 40), f"{score:+.2f}",
              font=F_HUD, fill=bcol + (255,))

    # 图例（中下）
    cats = [("LIQ","流动性"),("MACRO","宏观"),("ONCHAIN","链上"),
            ("DERIV","衍生品"),("COMMOD","大宗"),("FX","外汇"),("RISK","信用/情绪")]
    lx, ly = 660, H - 150
    for i, (c, name) in enumerate(cats):
        col = hex2rgb(COL[c])
        draw.ellipse([lx, ly + 2, lx + 18, ly + 20], fill=col + (255,))
        draw.text((lx + 26, ly), name, font=F_LEG, fill=(210, 225, 245, 230))
        lx += 145

    # 底部中文解说（随阶段）
    cap = caption_at(s)
    cw = draw.textlength(cap, font=F_CAP)
    draw.text(((W - cw) / 2, H - 70), cap, font=F_CAP, fill=(205, 222, 245, 240))

    # 进度条（极细，底部）
    pw = int((frame / N_FRAMES) * W)
    draw.rectangle([0, H - 3, pw, H], fill=(120, 200, 255, 200))

# ----------------------------------------------------------------------------
# 冲击涟漪（RED 阶段，从 DVOL/FEAR 扩散）
# ----------------------------------------------------------------------------
def draw_ripples(d, s, time):
    if s < 0.6:
        return
    strength = (s - 0.6) / 0.4
    for src, ph in (("DVOL", 0.0), ("FEAR", 1.6), ("HYG", 3.1)):
        x, y = P_CACHE[src]
        phase = (time * 0.6 + ph) % 2.2
        rr = 30 + phase * 220
        a = int((1 - phase / 2.2) * 130 * strength)
        if a > 0:
            draw = ImageDraw.Draw(d)
            draw.ellipse([x - rr, y - rr, x + rr, y + rr],
                         outline=(255, 90, 90, a), width=3)

# ----------------------------------------------------------------------------
# 主渲染循环
# ----------------------------------------------------------------------------
def advance_trail(frame, particles, trail):
    """推进拖尾层：淡出 + 粒子生成/更新/绘制（render_frame 与 probe 共用）"""
    t = frame / (N_FRAMES - 1)
    time = frame / FPS
    s = stress_at(t)
    L = liquidity_at(s)
    for k in NODE:
        P_CACHE[k] = node_pos(k, t, s, time)
    trail = Image.blend(trail, BG, 0.20)
    spawn_rate = int(2 + 6 * L)
    particles.spawn(spawn_rate)
    particles.update(1.0 / FPS, L)
    pcol = lerp_col((255, 200, 87), (255, 80, 80), 1 - L)
    core_col = lerp_col((255, 236, 190), (255, 160, 150), 1 - L)
    for it in particles.items:
        ei, p, _, sz = it
        x, y = particle_pos(ei, p)
        spr = glow(sz * 1.7, pcol, peak=0.40)
        trail.alpha_composite(spr, (int(x - sz * 1.7), int(y - sz * 1.7)))
        spr2 = glow(sz * 0.75, core_col, peak=0.9)
        trail.alpha_composite(spr2, (int(x - sz * 0.75), int(y - sz * 0.75)))
    return trail

def render_frame(frame, particles, trail):
    t = frame / (N_FRAMES - 1)
    time = frame / FPS
    s = stress_at(t)
    L = liquidity_at(s)

    trail = advance_trail(frame, particles, trail)

    # 组合：trail 作为底，叠加连边/节点/HUD
    d = trail.copy()
    # 承压红晕
    if s > 0.05:
        d.alpha_composite(RED_TINT, (0, 0))
    for e in EDGES:
        draw_edge(d, e[0], e[1], e, s, time)
    draw_ripples(d, s, time)
    for k in NODE:
        draw_node(d, k, s, time)
    draw_hud(d, s, time, frame)

    return d.convert("RGB"), trail

P_CACHE = {}

def main():
    preview = False
    for arg in sys.argv[1:]:
        if arg.startswith("--preview"):
            preview = True
            n = 3
            if "=" in arg:
                n = int(arg.split("=")[1])
            run_preview(n)
            return
        if arg.startswith("--probe"):
            fr = int(arg.split("=")[1]) if "=" in arg else int(N_FRAMES * 0.08)
            run_probe(fr)
            return

    os.makedirs(OUT_DIR, exist_ok=True)
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [ff, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "17",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUT_MP4]
    print("encoding ->", OUT_MP4)
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    particles = Particles()
    trail = BG.copy()
    for frame in range(N_FRAMES):
        rgb, trail = render_frame(frame, particles, trail)
        proc.stdin.write(rgb.tobytes())
        if frame % 60 == 0:
            print(f"  frame {frame}/{N_FRAMES}  s={stress_at(frame/(N_FRAMES-1)):.2f}")
    proc.stdin.close()
    proc.wait()
    print("done ->", OUT_MP4, "exists:", os.path.exists(OUT_MP4))

def run_preview(n):
    particles = Particles()
    trail = BG.copy()
    # 选关键阶段：平静 / 升温 / 承压
    picks = [int(N_FRAMES*0.08), int(N_FRAMES*0.55), int(N_FRAMES*0.92)]
    picks = picks[:n]
    for i, f in enumerate(picks):
        rgb, trail = render_frame(f, particles, trail)
        p = f"/tmp/nexus_preview_{i}.png"
        rgb.save(p)
        print("preview", p, "s=", round(stress_at(f/(N_FRAMES-1)),2))
def run_probe(target):
    """低成本稳态预览：只推进拖尾/粒子到 target 帧（跳过昂贵的边/节点/HUD），再完整渲染一帧"""
    particles = Particles()
    trail = BG.copy()
    for f in range(target):
        trail = advance_trail(f, particles, trail)
    rgb, _ = render_frame(target, particles, trail)
    p = f"/tmp/nexus_probe_{target}.png"
    rgb.save(p)
    print("probe", p, "s=", round(stress_at(target/(N_FRAMES-1)), 2),
          "particles=", len(particles.items))

if __name__ == "__main__":
    main()
