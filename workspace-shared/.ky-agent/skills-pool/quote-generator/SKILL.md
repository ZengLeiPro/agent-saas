---
name: quote-generator
description: "为客户生成 PDF 格式的报价书。当用户要求制作报价书、出报价、生成报价单、给客户报价、做一份报价方案时触发此 skill。也适用于用户提到「帮我给XX公司出个报价」「做份报价书」「报价表」等场景。支持纯报价书和报价+解决方案文档的复合文档。如果用户要修改已有报价书，也应使用此 skill。不要在用户只是讨论价格策略或询问定价建议时触发。"
---

# 报价书生成器

为定制化业务客户生成 PDF 报价书。

## 第一步：信息采集（必须执行）

收到报价书需求后，**先分析用户已提供的信息，识别缺失项，使用 AskUserQuestion 工具一次性提问**。不要边做边问，也不要在信息不全时就开始生成。

### 必须确认的信息

| 信息 | 判断逻辑 |
|------|---------|
| 客户公司全称 | 用户未提及 → 必问 |
| 报价人（哪位销售） | 用户未指定 → 必问（参考下方销售速查表） |
| 服务项目及价格 | 用户未列明具体项目和金额 → 必问 |
| 是否钉钉相关 | 如果从上下文无法判断 → 问（决定 title 和钉钉 logo） |

### 可以智能默认的信息

| 信息 | 默认值 | 何时需要问 |
|------|--------|----------|
| 报价方公司 | 福建开沿科技有限公司 | 几乎不需要问 |
| 报价日期 | 当天日期 | 用户说了"上周报的价"等特殊情况才问 |
| 有效期 | 30 天 | 用户有特殊要求才问 |
| 附件模块说明 | 无 | 用户提到了定制开发模块时，主动问是否需要附件说明 |
| 解决方案文档 | 无 | 定制开发类项目，主动问是否需要附带方案文档 |
| 页脚备注 | 有默认值 | 不需要问 |

### 提问示例

当用户说"帮我给XX公司出个报价"，但只给了公司名，应这样提问：

> 报价书需要以下信息，请补充：
> 1. **报价人**：哪位销售负责？（彭一宁 / 黄思霖 / 陈育新 / 许锐宏）
> 2. **服务项目**：具体报哪些项目？每项的价格和收费方式（一次性/按年订阅/免费）是什么？
> 3. **是否钉钉项目**：标题用"钉钉数字化解决方案报价书"还是其他？

当用户给的信息已经比较完整（如"帮我出个报价，宝畅建设，彭一宁，项目管理定制开发 21000 一次性"），则直接组装 JSON 生成，不需要提问。

## 第二步：生成报价书

信息齐全后：
1. 组装 JSON 数据文件，写入 `assets/quotes/` 目录
2. 调用生成脚本，输出 HTML + PDF + JSON 三个文件
3. 将 PDF 文件交付给用户

## 调用方式

```bash
python3 SKILL_DIR/scripts/generate_quote.py <input.json> <output_dir>
```

- `SKILL_DIR` = 本 skill 的绝对路径（即本文件所在目录）
- `input.json` = 报价数据 JSON 文件（结构见下方 Schema）
- `output_dir` = 输出目录，通常为 `assets/quotes/`（目录不存在时自动创建）

输出文件命名：`{客户名}_报价书.html` / `.pdf` / `.json`

## JSON Schema

```json
{
  "customer": "客户公司全称（必填）",
  "title": "文档标题（选填，默认：钉钉数字化解决方案报价书）",
  "quoter": {
    "company": "报价方公司名（必填，通常为：福建开沿科技有限公司）",
    "name": "报价人姓名（必填）",
    "phone": "报价人电话（必填）"
  },
  "date": "报价日期（必填，格式：YYYY年MM月DD日）",
  "validDays": 30,
  "showDingtalkLogo": true,

  "serviceTables": [
    {
      "type": "simple 或 detailed（见下方说明）",
      "title": "一、服务",
      "items": ["（结构取决于 type，见下方说明）"],
      "summaryRows": [
        {"label": "小计", "value": 21000},
        {"label": "费用总计", "value": 21000, "highlight": true}
      ]
    }
  ],

  "attachments": [
    {
      "title": "附件一：定制开发功能及模块说明",
      "modules": [
        {
          "category": "功能分类名（可选，有此字段时启用三列布局）",
          "name": "模块名称",
          "features": [
            "功能描述1",
            "功能描述2"
          ]
        }
      ]
    }
  ],

  "extraNotes": "**其他说明：**\n\n补充文字（Markdown 格式，可选）",

  "solution": {
    "title": "项目需求说明书（显示在分割线下方的居中标题）",
    "file": "path/to/solution.md（Markdown 文件路径，相对于 JSON 文件所在目录）"
  },

  "footerNotes": [
    "如有任何问题，欢迎随时致电。",
    "此报价表为意向性报价，有效期内可参照查看。贵方应严守保密义务，不得向第三方披露。"
  ]
}
```

### 两种报价表类型

#### 1. `type: "simple"`（默认）

适用于服务类报价，列为：序号、项目、收费方式、总价（元）。

```json
{
  "type": "simple",
  "title": "一、服务",
  "items": [
    {
      "name": "项目名称",
      "description": "可选的补充说明（灰色小字）",
      "chargeType": "一次性 | 按年订阅 | 免费",
      "price": 21000,
      "remark": "可选备注（任一 item 有 remark 时自动显示备注列）"
    }
  ],
  "summaryRows": [
    {"label": "小计", "value": 21000}
  ]
}
```

#### 2. `type: "detailed"`

适用于软件/硬件类报价，列为：序号、项目、规格、收费方式、单价（元）、数量、总价（元）、备注。

```json
{
  "type": "detailed",
  "title": "一、软件",
  "items": [
    {
      "name": "钉钉低代码开发平台",
      "spec": "30 人",
      "chargeType": "按年订阅",
      "unitPrice": 5988,
      "quantity": 1,
      "total": 5988,
      "remark": "-"
    }
  ],
  "summaryRows": [
    {"label": "小计", "value": 5988}
  ]
}
```

### summaryRows 说明

- `label`：行标签文字（如"小计"、"费用总计"），右对齐显示
- `value`：金额数值，数字类型
- `highlight`：可选布尔值。设为 `true` 时，该行使用蓝色背景高亮且不显示备注列，适用于"费用总计"等汇总行

### 附件两种布局

#### 简单布局（两列：业务模块、功能详细描述）

当 modules 中没有 `category` 字段时使用：

```json
{
  "title": "附件一：定制开发功能及模块说明",
  "modules": [
    {
      "name": "项目管理模块",
      "features": ["功能1", "功能2"]
    }
  ]
}
```

#### 分类布局（三列：功能分类、业务模块、功能描述）

当 modules 中包含 `category` 字段时自动启用，同一 category 的行自动合并单元格：

```json
{
  "title": "附件一：定制开发功能及模块说明",
  "modules": [
    {
      "category": "基础表单",
      "name": "客户表单",
      "features": ["关联运费表单，支持批量导入，导出，批量修改", "填写客户名称、计价规则等数据"]
    },
    {
      "category": "基础表单",
      "name": "运费表单",
      "features": ["支持批量导入，导出，批量修改", "填写计价表名称、抛比、明细等"]
    },
    {
      "category": "功能表",
      "name": "运费计算表",
      "features": ["通过选择客户名称，自动带出价格单", "自动计算最优运费"]
    }
  ]
}
```

### 字段速查表

| 字段 | 必填 | 说明 |
|------|------|------|
| `customer` | ✅ | 客户公司全称，显示在报价书头部蓝色大字 |
| `title` | ❌ | 文档标题，默认"钉钉数字化解决方案报价书" |
| `quoter` | ✅ | 报价方信息对象 |
| `quoter.company` | ✅ | 默认用"福建开沿科技有限公司" |
| `quoter.name` | ✅ | 负责该客户的销售姓名 |
| `quoter.phone` | ✅ | 销售电话 |
| `date` | ✅ | 格式 `YYYY年MM月DD日` |
| `validDays` | ❌ | 报价有效天数，默认 30 |
| `showDingtalkLogo` | ❌ | 是否显示钉钉 Logo，默认 true。非钉钉相关项目设为 false |
| `serviceTables` | ✅ | 报价表数组，至少 1 个 |
| `serviceTables[].type` | ❌ | `"simple"`（默认）或 `"detailed"` |
| `serviceTables[].title` | ✅ | 表标题，如"一、软件"、"二、服务" |
| `serviceTables[].items` | ✅ | 条目数组（结构取决于 type） |
| **simple items** | | |
| `.name` | ✅ | 项目名称 |
| `.description` | ❌ | 补充说明（灰色小字） |
| `.chargeType` | ✅ | 收费方式 |
| `.price` | ✅ | 总价，数字类型 |
| `.remark` | ❌ | 备注。任一 item 有 remark 时自动增加备注列 |
| **detailed items** | | |
| `.name` | ✅ | 项目名称 |
| `.description` | ❌ | 补充说明（灰色小字） |
| `.spec` | ❌ | 规格（如"30 人"） |
| `.chargeType` | ✅ | 收费方式 |
| `.unitPrice` | ✅ | 单价，数字类型 |
| `.quantity` | ✅ | 数量，数字类型 |
| `.total` | ✅ | 总价，数字类型（需手动计算 unitPrice × quantity） |
| `.remark` | ❌ | 备注，默认"-" |
| **summaryRows** | | |
| `.label` | ✅ | 行标签（如"小计"、"费用总计"） |
| `.value` | ✅ | 金额数值 |
| `.highlight` | ❌ | 高亮行（蓝色背景，无备注列） |
| `extraNotes` | ❌ | 报价表后的补充说明（Markdown 格式） |
| `attachments` | ❌ | 附件说明数组 |
| `attachments[].modules[].category` | ❌ | 功能分类。有此字段时启用三列分类布局 |
| `solution` | ❌ | 解决方案文档，附在报价书后面 |
| `solution.title` | ❌ | 方案标题，居中显示 |
| `solution.file` | ✅* | Markdown 路径（相对于 JSON 所在目录）。*solution 存在时必填 |
| `footerNotes` | ❌ | 页脚备注，有默认值 |

### 完整示例：软件+硬件+服务（匹配标准模板）

```json
{
  "customer": "XX有限公司",
  "title": "钉钉数字化解决方案报价书",
  "quoter": {
    "company": "福建开沿科技有限公司",
    "name": "彭一宁",
    "phone": "15959927990"
  },
  "date": "2026年03月25日",
  "validDays": 30,
  "showDingtalkLogo": true,
  "serviceTables": [
    {
      "type": "detailed",
      "title": "一、软件",
      "items": [
        {
          "name": "钉钉低代码开发平台",
          "spec": "30 人",
          "chargeType": "按年订阅",
          "unitPrice": 5988,
          "quantity": 1,
          "total": 5988,
          "remark": "-"
        }
      ],
      "summaryRows": [
        {"label": "小计", "value": 5988}
      ]
    },
    {
      "type": "detailed",
      "title": "二、硬件",
      "items": [
        {
          "name": "某硬件设备",
          "spec": "",
          "chargeType": "一次性",
          "unitPrice": 5988,
          "quantity": 1,
          "total": 5988,
          "remark": "-"
        }
      ],
      "summaryRows": [
        {"label": "小计", "value": 5988}
      ]
    },
    {
      "title": "三、服务",
      "items": [
        {
          "name": "模块定制开发",
          "description": "（详见下方附件一：定制开发功能及模块说明）",
          "chargeType": "一次性",
          "price": 40000,
          "remark": "-"
        },
        {
          "name": "需求调研、系统整体使用培训、服务期限内系统日常维护调整",
          "chargeType": "一次性",
          "price": 4000,
          "remark": "-"
        }
      ],
      "summaryRows": [
        {"label": "小计", "value": 44000},
        {"label": "费用总计", "value": 55976, "highlight": true}
      ]
    }
  ],
  "extraNotes": "**其他说明：**\n\n无。",
  "attachments": [
    {
      "title": "附件一：定制开发功能及模块说明",
      "modules": [
        {
          "category": "基础表单",
          "name": "客户表单",
          "features": [
            "关联运费表单，支持批量导入，导出，批量修改",
            "填写客户名称，计价规则，保费，计算方式，计价表名称，价格单编号，客户编号，提交人，提交人组织，创建时间及修改时间等数据"
          ]
        },
        {
          "category": "基础表单",
          "name": "运费表单",
          "features": [
            "支持批量导入，导出，批量修改",
            "填写计价表名称，抛比，明细（省份，城市，首重，首重运费，续重，最低收费，价格/方）"
          ]
        },
        {
          "category": "基础表单",
          "name": "成本价表单",
          "features": [
            "支持批量导入，导出，批量修改",
            "填写计价表名称，抛比，明细（省份，城市，首重，首重运费，续重，最低收费，价格/方）"
          ]
        },
        {
          "category": "功能表",
          "name": "运费计算表",
          "features": [
            "支持批量导入，导出，批量修改",
            "通过选择客户名称，自动带出价格单（价格单编号，计价表名称，计算方式）",
            "通过填写计件明细（长，宽，高，件数）自动计算出尺寸",
            "长，宽，高，件数填写完之后填入实重，系统自动计算出不同抛比之间的实重，然后得出最优运费",
            "计件明细支持批量导入"
          ]
        },
        {
          "category": "功能表",
          "name": "成本价核算表",
          "features": [
            "通过导入卡号成本再根据成本价运费自动核算成本金额",
            "有异常的做提醒"
          ]
        },
        {
          "category": "功能表",
          "name": "利润价格表",
          "features": [
            "自动算出利润金额及利润率",
            "支持以客户，时间的维度来灵活进行计算汇总"
          ]
        },
        {
          "category": "相关服务",
          "name": "产品使用培训",
          "features": [
            "提供线下系统操作培训",
            "提供系统完整操作手册"
          ]
        },
        {
          "category": "相关服务",
          "name": "系统部署服务",
          "features": [
            "每个表单都支持独立配置权限包含（可新增、可删除、可查看、可修改）等权限，可根据需求个性化配置权限",
            "协助前期基础信息导入工作",
            "系统上线后续提供5*24小时答疑及维护"
          ]
        }
      ]
    }
  ]
}
```

### 纯服务报价示例（简单模式）

```json
{
  "customer": "福建宝畅建设发展有限公司",
  "title": "钉钉数字化解决方案报价书",
  "quoter": {
    "company": "福建开沿科技有限公司",
    "name": "彭一宁",
    "phone": "15959927990"
  },
  "date": "2026年01月23日",
  "validDays": 30,
  "showDingtalkLogo": true,
  "serviceTables": [
    {
      "title": "一、服务",
      "items": [
        {
          "name": "项目管理模块定制开发",
          "description": "（详见下方附件一：定制开发功能及模块说明）",
          "chargeType": "一次性",
          "price": 21000
        },
        {
          "name": "需求调研、系统整体使用培训",
          "chargeType": "免费",
          "price": 0
        },
        {
          "name": "系统日常维护调整",
          "chargeType": "按年订阅",
          "price": 1050
        }
      ],
      "summaryRows": [
        {"label": "小计", "value": 21000},
        {"label": "首年费用合计", "value": 21000},
        {"label": "第二年费用", "value": 1050}
      ]
    }
  ],
  "attachments": [
    {
      "title": "附件一：定制开发功能及模块说明",
      "modules": [
        {
          "name": "项目管理模块定制开发",
          "features": [
            "项目制定板块：包含项目基础信息、合同管理、财务管理、BI看板、流程审批、权限控制等",
            "项目合同管理板块：合同起草、审批、归档、履约跟踪全流程管理",
            "项目财务管理板块：支持贴合企业财务流程的收支统计、报销申请、开票申请等功能",
            "项目BI看板：以项目为维度，支持成本归集、核心数据可视化展示、导出报表等功能"
          ]
        }
      ]
    }
  ]
}
```

### 常见 summaryRows 模板

**标准定制开发报价（有续费）：**
```json
"summaryRows": [
  {"label": "小计", "value": 21000},
  {"label": "首年费用合计", "value": 21000},
  {"label": "第二年费用", "value": 1050}
]
```

**纯一次性服务：**
```json
"summaryRows": [
  {"label": "服务费小计", "value": 6000},
  {"label": "费用合计", "value": 6000}
]
```

**多表汇总（费用总计放在最后一个表的 summaryRows 中）：**
```json
"summaryRows": [
  {"label": "小计", "value": 44000},
  {"label": "费用总计", "value": 55976, "highlight": true}
]
```

## 选择表类型的判断逻辑

| 场景 | 使用的 type | 说明 |
|------|-----------|------|
| 软件订阅（钉钉平台、SaaS 产品等） | `detailed` | 通常有规格（人数）、单价、数量 |
| 硬件采购（设备、服务器等） | `detailed` | 通常有规格型号、单价、数量 |
| 定制开发服务 | `simple` | 通常按项目整体报价，无单价×数量 |
| 培训、咨询、维护等 | `simple` | 按项目报价 |
| 混合报价（软件+服务） | 混用 | 软件表用 detailed，服务表用 simple |

## 销售人员速查

常用报价人信息（如用户未指定报价人，应询问确认）：

| 姓名 | 电话 |
|------|------|
| 彭一宁 | 15959927990 |
| 黄思霖 | （需确认） |
| 陈育新 | （需确认） |
| 许锐宏 | （需确认） |

## 修改已有报价书

1. 找到对应的 `.json` 文件（`assets/quotes/` 目录下按客户名搜索）
2. 修改 JSON 内容
3. 重新运行生成脚本，会覆盖同名文件

## 解决方案文档工作流

当用户需要在报价书后附带方案文档时：

1. **来源是钉钉文档**：用 dingtalk-docs skill 读取 Markdown → 保存为 `.md` 文件 → JSON 中 `solution.file` 指向该文件
2. **来源是本地文件**：如已有 `.md` 文件，直接引用；如是其他格式，转换为 Markdown 后引用
3. **需要 AI 生成**：根据用户描述撰写 Markdown 方案文档 → 保存为 `.md` 文件 → 引用

方案 Markdown 支持的格式：标题（h1-h4）、有序/无序列表（含嵌套）、表格、图片（URL 或本地路径，自动 base64 内嵌）、加粗/斜体、`<span style="color:">` 彩色文字、链接、引用块、分割线。

## 注意事项

- **price / unitPrice / total / value 必须是数字**，不要用字符串（正确：`21000`，错误：`"21,000"`）
- summaryRows 的 value 需要自行计算正确，脚本不会自动求和
- detailed 表的 total 也需手动计算（unitPrice × quantity），脚本不会自动乘
- 生成依赖 Node.js playwright 和 Python mistune（均已安装）；PDF 渲染优先用 chromium，在受限沙箱等 chromium 起不来的环境下自动降级到 weasyprint（若已安装），保证仍能产出 PDF
- **中文字体兼容性（重要）**：模板 `body` 的 `font-family` 首选 `Heiti SC`(TrueType)，绝不可把 `PingFang SC` / `Hiragino Sans GB` 放首位。后者是 OpenType CFF 字体，子集嵌入 PDF 为 `FontFile3`，国产手机阅读器（微信内置预览、QQ 浏览器等）对 CFF 子集支持不全，会导致中文乱码/方块——而桌面端渲染引擎能 fallback，自测发现不了。验证方法：用 `pypdf` 检查字体描述符，全文应为 `FontFile2`(TrueType) 而非 `FontFile3`(CFF)；或用 poppler 的 `pdftoppm` 渲染成 PNG 肉眼检查（其渲染逻辑接近手机阅读器）
- Logo 文件在 `scripts/logos/` 目录下（kaiyan.png + dingtalk.png），如需更换直接替换对应文件
- solution.file 的路径相对于 JSON 文件所在目录解析
