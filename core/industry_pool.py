"""十五五成长行业股票池（科技 / 优质医药 / 电力），纯主板，可编辑、动态可控。

设计说明：
- 仅保留沪市 60 开头、深市 00 开头的【主板】股，剔除科创板(688)、创业板(300/301)。
- 赛道贴合十五五：科技（半导体/AI算力/机器人/低空/商业航天/新材料/通信）、
  优质医药（创新药/器械/CXO/中药）、电力（绿电/储能电网/核电）。剔夕阳行业。
- 每项字段：code, name, track(细分赛道), sector(大类), grade(质量档), note(亮点)。
- 想增删：直接改 data/industry_pool.json 或下方 POOL 即可，无需改代码。
"""

import os
import json

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POOL_JSON = os.path.join(BASE, "data", "industry_pool.json")

# 内置兜底池：即使 JSON 丢失也能跑。纯主板（60/00 开头），剔 688/300/301。
POOL = [
    # ====================== 科技 ======================
    # 半导体
    {"code": "sz002371", "name": "北方华创", "track": "半导体·设备", "sector": "科技", "grade": "A", "note": "半导体设备平台型龙头"},
    {"code": "sh603501", "name": "韦尔股份", "track": "半导体·CIS", "sector": "科技", "grade": "A", "note": "图像传感器龙头，车载/手机双驱动"},
    {"code": "sh603986", "name": "兆易创新", "track": "半导体·存储", "sector": "科技", "grade": "A", "note": "NOR Flash/MCU 龙头"},
    {"code": "sh600584", "name": "长电科技", "track": "半导体·封测", "sector": "科技", "grade": "B", "note": "封测龙头，先进封装受益"},
    {"code": "sz002049", "name": "紫光国微", "track": "半导体·安全芯片", "sector": "科技", "grade": "A", "note": "特种芯片+FPGA，国产替代"},
    {"code": "sh600460", "name": "士兰微", "track": "半导体·IDM", "sector": "科技", "grade": "B", "note": "功率半导体IDM，新能源受益"},
    # AI 算力
    {"code": "sh601138", "name": "工业富联", "track": "AI算力·服务器", "sector": "科技", "grade": "B", "note": "AI服务器代工龙头"},
    {"code": "sh603019", "name": "中科曙光", "track": "AI算力·算力基础设施", "sector": "科技", "grade": "A", "note": "国产算力底座"},
    {"code": "sz000977", "name": "浪潮信息", "track": "AI算力·服务器", "sector": "科技", "grade": "B", "note": "服务器出货龙头"},
    {"code": "sz000938", "name": "紫光股份", "track": "AI算力·网络设备", "sector": "科技", "grade": "B", "note": "交换机/服务器，智算网络"},
    # 机器人
    {"code": "sz002747", "name": "埃斯顿", "track": "机器人·本体", "sector": "科技", "grade": "B", "note": "国产工业机器人本体领先"},
    {"code": "sz002472", "name": "双环传动", "track": "机器人·减速器", "sector": "科技", "grade": "B", "note": "精密齿轮/RV减速器"},
    {"code": "sz002050", "name": "三花智控", "track": "机器人·执行器", "sector": "科技", "grade": "A", "note": "热管理+机器人执行器"},
    {"code": "sh601689", "name": "拓普集团", "track": "机器人·执行器", "sector": "科技", "grade": "A", "note": "汽车零部件+机器人执行器"},
    {"code": "sh603728", "name": "鸣志电器", "track": "机器人·电机", "sector": "科技", "grade": "B", "note": "步进/无刷电机，机器人关节"},
    # 低空经济
    {"code": "sz000099", "name": "中信海直", "track": "低空经济·运营", "sector": "科技", "grade": "B", "note": "直升机运营，低空场景落地"},
    {"code": "sz002085", "name": "万丰奥威", "track": "低空经济·eVTOL", "sector": "科技", "grade": "C", "note": "eVTOL题材，估值偏高"},
    {"code": "sz001696", "name": "宗申动力", "track": "低空经济·动力", "sector": "科技", "grade": "C", "note": "航空发动机/摩企转型"},
    # 商业航天
    {"code": "sh600118", "name": "中国卫星", "track": "商业航天·制造", "sector": "科技", "grade": "B", "note": "小卫星研制龙头"},
    {"code": "sh600879", "name": "航天电子", "track": "商业航天·配套", "sector": "科技", "grade": "B", "note": "航天电子配套核心"},
    {"code": "sh601698", "name": "中国卫通", "track": "商业航天·运营", "sector": "科技", "grade": "B", "note": "卫星通信运营"},
    # 新材料
    {"code": "sh600206", "name": "有研新材", "track": "新材料", "sector": "科技", "grade": "B", "note": "半导体材料/稀土靶材"},
    {"code": "sh600456", "name": "宝钛股份", "track": "新材料·钛合金", "sector": "科技", "grade": "B", "note": "钛合金龙头，航空+半导体"},
    {"code": "sz000970", "name": "中科三环", "track": "新材料·稀土永磁", "sector": "科技", "grade": "B", "note": "钕铁硼永磁，机器人/新能源"},
    {"code": "sh600862", "name": "中航高科", "track": "新材料·复材", "sector": "科技", "grade": "B", "note": "航空复合材料龙头"},
    # 通信
    {"code": "sz000063", "name": "中兴通讯", "track": "通信·设备", "sector": "科技", "grade": "A", "note": "通信设备龙头，5G/6G"},
    {"code": "sh600498", "name": "烽火通信", "track": "通信·设备", "sector": "科技", "grade": "B", "note": "光通信，算力网络受益"},
    # ====================== 医药 ======================
    # 创新药
    {"code": "sh600276", "name": "恒瑞医药", "track": "医药·创新药", "sector": "医药", "grade": "A", "note": "创新药标杆，管线丰富"},
    {"code": "sh600196", "name": "复星医药", "track": "医药·创新药", "sector": "医药", "grade": "B", "note": "综合药企，mRNA/创新布局"},
    {"code": "sz002422", "name": "科伦药业", "track": "医药·创新药", "sector": "医药", "grade": "A", "note": "大输液+创新药+ADC"},
    {"code": "sz000963", "name": "华东医药", "track": "医药·创新药", "sector": "医药", "grade": "B", "note": "医美+创新药双轮"},
    {"code": "sz002294", "name": "信立泰", "track": "医药·创新药", "sector": "医药", "grade": "B", "note": "心血管创新药"},
    {"code": "sz002262", "name": "恩华药业", "track": "医药·创新药", "sector": "医药", "grade": "B", "note": "中枢神经用药龙头"},
    # 器械 / CXO
    {"code": "sz002223", "name": "鱼跃医疗", "track": "医药·器械", "sector": "医药", "grade": "B", "note": "家用医疗器械龙头"},
    {"code": "sh603259", "name": "药明康德", "track": "医药·CXO", "sector": "医药", "grade": "A", "note": "全球CXO龙头"},
    {"code": "sz002821", "name": "凯莱英", "track": "医药·CXO", "sector": "医药", "grade": "B", "note": "CDMO领先"},
    # 中药
    {"code": "sh600436", "name": "片仔癀", "track": "医药·中药", "sector": "医药", "grade": "A", "note": "中药瑰宝，强品牌溢价"},
    {"code": "sz000538", "name": "云南白药", "track": "医药·中药", "sector": "医药", "grade": "B", "note": "中药消费龙头"},
    {"code": "sh600085", "name": "同仁堂", "track": "医药·中药", "sector": "医药", "grade": "B", "note": "老字号中药"},
    {"code": "sz000423", "name": "东阿阿胶", "track": "医药·中药", "sector": "医药", "grade": "B", "note": "阿胶龙头，困境反转"},
    # ====================== 电力 ======================
    # 绿电
    {"code": "sh600905", "name": "三峡能源", "track": "电力·绿电", "sector": "电力", "grade": "A", "note": "风电/光伏运营龙头"},
    {"code": "sh600025", "name": "华能水电", "track": "电力·绿电", "sector": "电力", "grade": "A", "note": "水电优质资产"},
    {"code": "sh600900", "name": "长江电力", "track": "电力·绿电", "sector": "电力", "grade": "A", "note": "水电龙头，稳定现金流"},
    {"code": "sh600886", "name": "国投电力", "track": "电力·绿电", "sector": "电力", "grade": "B", "note": "水电+火电组合"},
    {"code": "sz000591", "name": "太阳能", "track": "电力·绿电", "sector": "电力", "grade": "B", "note": "光伏电站运营"},
    # 储能 / 电网
    {"code": "sh600406", "name": "国电南瑞", "track": "电力·电网", "sector": "电力", "grade": "A", "note": "电网自动化/特高压龙头"},
    {"code": "sz000400", "name": "许继电气", "track": "电力·电网", "sector": "电力", "grade": "B", "note": "特高压/智能电网装备"},
    {"code": "sh600089", "name": "特变电工", "track": "电力·电网", "sector": "电力", "grade": "B", "note": "变压器/特高压，新能源EPC"},
    {"code": "sh601179", "name": "中国西电", "track": "电力·电网", "sector": "电力", "grade": "B", "note": "输配电装备龙头"},
    {"code": "sh601126", "name": "四方股份", "track": "电力·电网", "sector": "电力", "grade": "B", "note": "继电保护/智能电网"},
    {"code": "sz002335", "name": "科华数据", "track": "电力·储能", "sector": "电力", "grade": "B", "note": "UPS/储能/数据中心"},
    # 核电
    {"code": "sh601985", "name": "中国核电", "track": "电力·核电", "sector": "电力", "grade": "A", "note": "核电运营双寡头"},
    {"code": "sz003816", "name": "中国广核", "track": "电力·核电", "sector": "电力", "grade": "B", "note": "核电运营"},
]


def _load():
    if os.path.isfile(POOL_JSON):
        try:
            data = json.load(open(POOL_JSON, encoding="utf-8"))
            if isinstance(data, list) and data:
                return data
        except Exception:
            pass
    return POOL


_POOL = _load()
_BY_CODE = {p["code"]: p for p in _POOL}


def pool_codes():
    """返回候选扫描用的代码列表。"""
    return [p["code"] for p in _POOL]


def get_fund(code):
    """返回某代码的行业池元数据（含 grade / track / sector / note）。"""
    return _BY_CODE.get(code)


def pool_size():
    return len(_POOL)


def sectors():
    """返回所有大类行业名。"""
    s = []
    for p in _POOL:
        if p.get("sector") not in s:
            s.append(p.get("sector"))
    return s


def codes_by_sector(sector):
    return [p["code"] for p in _POOL if p.get("sector") == sector]
