#!/usr/bin/env node
/**
 * 开沿科技销售合同生成器
 * 读取 JSON 数据 -> 生成 Word (.docx) 合同文档
 *
 * Usage:
 *   node generate_contract.js <input.json> [output_dir]
 *
 * 输出:
 *   - {甲方名}_合同.docx
 *   - {甲方名}_合同.json (数据备份)
 */

const fs = require("fs");
const path = require("path");

let docx;
try {
  docx = require("docx");
} catch (err) {
  console.error(
    "Missing dependency: docx. Use the ACS image or a project-local Node dependency that makes require('docx') resolvable; do not install global npm packages during a user task."
  );
  process.exit(1);
}

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  AlignmentType,
  BorderStyle,
  WidthType,
  ShadingType,
  VerticalAlign,
  HeadingLevel,
} = docx;

// ============================================================
// 工具函数
// ============================================================

function todayYmd() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function defaultOutputDir() {
  return path.join(process.cwd(), "assets", todayYmd(), "contracts");
}

function safeFileStem(value, fallback) {
  let stem = String(value || "")
    .replace(/\s+/g, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/[^0-9A-Za-z\u3400-\u9fff._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "")
    .replace(/[._-]+$/, "");
  if (!stem) stem = fallback;
  if (stem.length > 24) stem = stem.slice(0, 24);
  return stem;
}

function resolveInside(baseDir, fileName) {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, fileName);
  const relative = path.relative(resolvedBase, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside output directory: ${fileName}`);
  }
  return resolved;
}

function uniqueOutputPaths(outputDir, baseName) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);

  for (let i = 0; i < 100; i++) {
    const suffix = i === 0 ? "" : `_${stamp}${i === 1 ? "" : `_${i}`}`;
    const name = `${baseName}${suffix}`;
    const docxPath = resolveInside(outputDir, `${name}.docx`);
    const jsonPath = resolveInside(outputDir, `${name}.json`);
    if (!fs.existsSync(docxPath) && !fs.existsSync(jsonPath)) {
      return { docxPath, jsonPath };
    }
  }

  throw new Error("Unable to find a non-conflicting output filename");
}

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid or missing field: ${field}`);
  }
}

function validateContractData(data) {
  assertNonEmptyString(data.partyA, "partyA");
  if (!Array.isArray(data.services) || data.services.length === 0) {
    throw new Error("Invalid or missing field: services");
  }
  data.services.forEach((service, index) => {
    assertNonEmptyString(service.name, `services[${index}].name`);
    assertNonEmptyString(service.content, `services[${index}].content`);
    assertNonEmptyString(service.description, `services[${index}].description`);
  });
  assertNonEmptyString(data.period && data.period.start, "period.start");
  assertNonEmptyString(data.period && data.period.end, "period.end");
  if (typeof data.totalAmount !== "number" || !Number.isFinite(data.totalAmount) || data.totalAmount < 0) {
    throw new Error("Invalid field: totalAmount must be a non-negative number");
  }
  assertNonEmptyString(data.projectManager && data.projectManager.name, "projectManager.name");
  assertNonEmptyString(data.projectManager && data.projectManager.phone, "projectManager.phone");
}

/** 人民币数字转大写 */
function amountToChinese(amount) {
  if (amount === 0) return "零元整";
  const digits = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
  const units = ["", "拾", "佰", "仟"];
  const bigUnits = ["", "万", "亿"];

  // 分离整数和小数
  const parts = String(amount).split(".");
  let intPart = parseInt(parts[0], 10);
  const decPart = parts.length > 1 ? parts[1].padEnd(2, "0").slice(0, 2) : "00";

  let result = "";

  // 处理整数部分
  if (intPart > 0) {
    const intStr = String(intPart);
    const groups = [];
    // 按4位分组
    for (let i = intStr.length; i > 0; i -= 4) {
      groups.unshift(intStr.slice(Math.max(0, i - 4), i));
    }

    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      const bigUnit = bigUnits[groups.length - 1 - g] || "";
      let groupStr = "";
      let zeroFlag = false;

      for (let i = 0; i < group.length; i++) {
        const d = parseInt(group[i], 10);
        const unit = units[group.length - 1 - i];

        if (d === 0) {
          zeroFlag = true;
        } else {
          if (zeroFlag) {
            groupStr += "零";
            zeroFlag = false;
          }
          groupStr += digits[d] + unit;
        }
      }

      if (groupStr) {
        result += groupStr + bigUnit;
      }
    }
    result += "元";
  }

  // 处理小数部分
  const jiao = parseInt(decPart[0], 10);
  const fen = parseInt(decPart[1], 10);

  if (jiao === 0 && fen === 0) {
    result += "整";
  } else {
    if (jiao > 0) {
      result += digits[jiao] + "角";
    } else if (intPart > 0) {
      result += "零";
    }
    if (fen > 0) {
      result += digits[fen] + "分";
    }
  }

  return result;
}

/** 格式化金额为千分位 */
function formatAmount(amount) {
  if (amount === 0) return "0";
  if (amount === Math.floor(amount)) {
    return Math.floor(amount).toLocaleString("zh-CN");
  }
  return amount.toLocaleString("zh-CN", { minimumFractionDigits: 2 });
}

// ============================================================
// 文档构建常量
// ============================================================

const PAGE_WIDTH = 11906; // A4
const PAGE_MARGIN_LEFT = 1440;
const PAGE_MARGIN_RIGHT = 1440;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN_LEFT - PAGE_MARGIN_RIGHT; // 9026

const THIN_BORDER = { style: BorderStyle.SINGLE, size: 1, color: "000000" };
const TABLE_BORDERS = {
  top: THIN_BORDER,
  bottom: THIN_BORDER,
  left: THIN_BORDER,
  right: THIN_BORDER,
};
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const NO_BORDERS = {
  top: NO_BORDER,
  bottom: NO_BORDER,
  left: NO_BORDER,
  right: NO_BORDER,
};

const CELL_MARGINS = { top: 60, bottom: 60, left: 100, right: 100 };

const FONT = "仿宋";
const FONT_SIZE = 24; // 12pt = 24 half-points

// ============================================================
// 文档构建辅助
// ============================================================

function text(str, options = {}) {
  return new TextRun({ text: str, font: FONT, size: FONT_SIZE, ...options });
}

function boldText(str, options = {}) {
  return text(str, { bold: true, ...options });
}

function para(children, options = {}) {
  if (typeof children === "string") {
    children = [text(children)];
  }
  return new Paragraph({
    spacing: { line: 360, after: 100 },
    ...options,
    children,
  });
}

function heading(str) {
  return new Paragraph({
    spacing: { line: 360, before: 200, after: 100 },
    children: [boldText(str)],
  });
}

function numberedClause(num, content) {
  // content 可以是字符串或 TextRun 数组
  const children =
    typeof content === "string"
      ? [text(`${num}、 ${content}`)]
      : [text(`${num}、 `), ...content];
  return para(children, {
    spacing: { line: 360, after: 80 },
    indent: { firstLine: 0 },
  });
}

function subClause(label, content) {
  return para([text(`${label}) ${content}`)], {
    spacing: { line: 360, after: 60 },
    indent: { left: 420 },
  });
}

function makeCell(children, options = {}) {
  const { width, colspan, rowspan, shading, vAlign } = options;
  const cellChildren = Array.isArray(children) ? children : [children];
  const cellOpts = {
    borders: TABLE_BORDERS,
    margins: CELL_MARGINS,
    children: cellChildren,
    verticalAlign: vAlign || VerticalAlign.CENTER,
  };
  if (width) cellOpts.width = { size: width, type: WidthType.DXA };
  if (colspan) cellOpts.columnSpan = colspan;
  if (rowspan) cellOpts.rowSpan = rowspan;
  if (shading)
    cellOpts.shading = { fill: shading, type: ShadingType.CLEAR };
  return new TableCell(cellOpts);
}

// ============================================================
// 主文档生成
// ============================================================

function generateContract(data) {
  const partyA = data.partyA;
  const title = data.title || "钉钉合作服务协议";
  const services = data.services || [];
  const period = data.period;
  const totalAmount = data.totalAmount;
  const pm = data.projectManager;
  const paymentTerms =
    data.paymentTerms ||
    `合同签订之日起五个工作日内，甲方向乙方一次性支付合同总款项，总计人民币（大写）${amountToChinese(totalAmount)}（¥${formatAmount(totalAmount)}）。`;

  const amountChinese = amountToChinese(totalAmount);
  const amountFormatted = formatAmount(totalAmount);

  // ---- 服务项目表列宽 ----
  const col1W = Math.round(CONTENT_WIDTH * 0.2); // 服务项目
  const col2W = Math.round(CONTENT_WIDTH * 0.35); // 服务内容
  const col3W = CONTENT_WIDTH - col1W - col2W; // 业务描述

  // ---- 构建服务行 ----
  const serviceRows = services.map((svc) => {
    // 服务内容支持 \n 分行
    const contentLines = svc.content.split("\n");
    const contentParas = contentLines.map(
      (line) =>
        new Paragraph({
          spacing: { line: 300, after: 40 },
          children: [text(line.trim(), { size: 20 })],
        })
    );

    return new TableRow({
      children: [
        makeCell(
          para([text(svc.name, { size: 20 })], {
            spacing: { line: 300 },
            alignment: AlignmentType.CENTER,
          }),
          { width: col1W }
        ),
        makeCell(contentParas, { width: col2W }),
        makeCell(
          para([text(svc.description, { size: 20 })], {
            spacing: { line: 300 },
          }),
          { width: col3W }
        ),
      ],
    });
  });

  // ---- 服务表头 ----
  const serviceHeaderRow = new TableRow({
    children: [
      makeCell(
        para([boldText("服务项目", { size: 20 })], {
          alignment: AlignmentType.CENTER,
          spacing: { line: 300 },
        }),
        { width: col1W, shading: "F2F2F2" }
      ),
      makeCell(
        para([boldText("服务内容", { size: 20 })], {
          alignment: AlignmentType.CENTER,
          spacing: { line: 300 },
        }),
        { width: col2W, shading: "F2F2F2" }
      ),
      makeCell(
        para([boldText("业务描述及实现方式", { size: 20 })], {
          alignment: AlignmentType.CENTER,
          spacing: { line: 300 },
        }),
        { width: col3W, shading: "F2F2F2" }
      ),
    ],
  });

  // ---- 服务期限行 ----
  const periodRow = new TableRow({
    children: [
      makeCell(
        para(
          [
            boldText("服务期限：", { size: 20 }),
            text(`${period.start}至${period.end}`, { size: 20 }),
          ],
          { spacing: { line: 300 } }
        ),
        { width: CONTENT_WIDTH, colspan: 3 }
      ),
    ],
  });

  // ---- 合同价款行 ----
  const amountRow = new TableRow({
    children: [
      makeCell(
        para(
          [
            boldText("本合同价款（含税）总计：", { size: 20 }),
            text(
              `人民币（大写）${amountChinese}（¥${amountFormatted}）`,
              { size: 20 }
            ),
          ],
          { spacing: { line: 300 } }
        ),
        { width: CONTENT_WIDTH, colspan: 3 }
      ),
    ],
  });

  // ---- 服务项目完整表格 ----
  const serviceTable = new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [col1W, col2W, col3W],
    rows: [serviceHeaderRow, ...serviceRows, periodRow, amountRow],
  });

  // ---- 项目负责人表格 ----
  const pmCol1 = Math.round(CONTENT_WIDTH * 0.5);
  const pmCol2 = CONTENT_WIDTH - pmCol1;

  const pmTable = new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [pmCol1, pmCol2],
    rows: [
      new TableRow({
        children: [
          makeCell(
            para([boldText("项目负责人", { size: 20 })], {
              alignment: AlignmentType.CENTER,
              spacing: { line: 300 },
            }),
            { width: pmCol1, shading: "F2F2F2" }
          ),
          makeCell(
            para([boldText("联系电话", { size: 20 })], {
              alignment: AlignmentType.CENTER,
              spacing: { line: 300 },
            }),
            { width: pmCol2, shading: "F2F2F2" }
          ),
        ],
      }),
      new TableRow({
        children: [
          makeCell(
            para([text(pm.name, { size: 20 })], {
              alignment: AlignmentType.CENTER,
              spacing: { line: 300 },
            }),
            { width: pmCol1 }
          ),
          makeCell(
            para([text(pm.phone, { size: 20 })], {
              alignment: AlignmentType.CENTER,
              spacing: { line: 300 },
            }),
            { width: pmCol2 }
          ),
        ],
      }),
    ],
  });

  // ---- 签章表格（无边框） ----
  const sigCol = Math.round(CONTENT_WIDTH * 0.5);
  const signatureTable = new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [sigCol, CONTENT_WIDTH - sigCol],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            borders: NO_BORDERS,
            width: { size: sigCol, type: WidthType.DXA },
            children: [
              para([boldText(`甲方：${partyA}`)], { spacing: { after: 400 } }),
              para([text("授权代表（签字）：")], { spacing: { after: 400 } }),
              para([text("签订日期：")]),
            ],
          }),
          new TableCell({
            borders: NO_BORDERS,
            width: { size: CONTENT_WIDTH - sigCol, type: WidthType.DXA },
            children: [
              para([boldText("乙方：福建开沿科技有限公司")], {
                spacing: { after: 400 },
              }),
              para([text("授权代表（签字）：")], { spacing: { after: 400 } }),
              para([text("签订日期：")]),
            ],
          }),
        ],
      }),
    ],
  });

  // ============================================================
  // 组装文档
  // ============================================================

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT, size: FONT_SIZE },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH, height: 16838 }, // A4
            margin: {
              top: 1440,
              right: PAGE_MARGIN_RIGHT,
              bottom: 1440,
              left: PAGE_MARGIN_LEFT,
            },
          },
        },
        children: [
          // ---- 标题 ----
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 300 },
            children: [
              new TextRun({
                text: title,
                font: FONT,
                size: 36, // 18pt
                bold: true,
              }),
            ],
          }),

          // ---- 甲乙方 ----
          para([text("甲方："), boldText(partyA)]),
          para([
            text("乙方："),
            boldText("福建开沿科技有限公司", { underline: {} }),
          ]),

          // ---- 前言 ----
          new Paragraph({
            spacing: { line: 360, before: 200, after: 200 },
            children: [
              text(
                "甲乙双方经友好协商，就乙方向甲方提供信息化相关产品及服务事宜，根据《中华人民共和国合同法》及其他法律法规签订本合同，双方达成如下协议："
              ),
            ],
          }),

          // ==== 第一条 ====
          heading("第一条：产品及服务"),
          serviceTable,

          // ==== 第二条 ====
          heading("第二条：乙方项目负责人员："),
          para(
            "乙方人员根据甲方实际需要，指派专人为甲方提供服务，服务方式包含但不限于现场服务、电话沟通、网络沟通等，乙方项目负责人："
          ),
          pmTable,
          para(
            "服务期间，若乙方项目负责人出现变更，乙方应于5个工作日内于书面形式告知甲方。",
            { spacing: { line: 360, before: 100, after: 100 } }
          ),

          // ==== 第三条 ====
          heading("第三条：付款方式及收款账户："),
          numberedClause(1, [
            text("付款方式："),
            text(paymentTerms),
          ]),
          para("2、乙方接受款项账户如下："),
          para([
            text("开户行："),
            boldText("招商银行泉州泉秀支行", { underline: {} }),
          ]),
          para([
            text("银行户名："),
            boldText("福建开沿科技有限公司", { underline: {} }),
          ]),
          para([
            text("银行账户："),
            boldText("595902938010801", { underline: {} }),
          ]),

          // ==== 第四条 ====
          heading("第四条：双方权利及义务"),
          numberedClause(
            1,
            "甲方向乙方交纳首付款后，甲方享有乙方关于信息化调研及服务的相关权利，并有责任积极配合乙方进行信息化部署工作，乙方应指派专人对甲方提供信息化指导及服务，并对甲方人员提供相应的使用培训；"
          ),
          numberedClause(
            2,
            "乙方向甲方提供产品在使用初期的产品功能演示、产品功能培训以及使用中期5*8小时电话服务支持，服务内容包括但不限于技术支持、产品使用帮助、功能讲解等，并保证在服务期内服务的连续性；"
          ),
          numberedClause(
            3,
            "乙方仅为甲方提供软件相关的网络服务，除此之外与相关网络服务有关的设备（如个人电脑、手机、及其他与接入互联网或移动网络有关的装置）及所需的费用（如为接入互联网而支付的电话费及上网费、为使用移动网而支付的手机费）均应由甲方自行负担。"
          ),
          numberedClause(4, "服务变更、中断或者终止"),
          para(
            "如发生下列任何一种情形，乙方有权随时中断或终止向甲方提供本合同项下的软件使用服务（该服务包括但不限于收费及免费服务）而无需对甲方承担任何责任：",
            { indent: { left: 420 } }
          ),
          subClause("a", "甲方提供的资料不真实；"),
          subClause(
            "b",
            "甲方违反本合同及附件、补充协议、政策中规定的使用规则；"
          ),
          subClause(
            "c",
            "甲方在使用合同约定的收费平台服务时未按规定向乙方支付相应的服务费。"
          ),
          numberedClause(
            5,
            "除了按照甲方要求完成指派的服务工作，乙方无权代表或以甲方的名义从事任何商业活动，本协议不在双方之间产生任何代理、合资、从属关系，任何一方在未得到对方的实际书面许可之前，不得使用对方的名称、商标、商号、标识等任何知识产权。"
          ),
          numberedClause(
            6,
            "乙方所提供的技术支持、维护服务，符合国家相关部门有关技术质量的规定标准和甲方需求。甲方有权对乙方工作人员的工作态度、完成情况进行监督、签收，提出意见，以提高维护服务质量。"
          ),
          numberedClause(
            7,
            "若甲方主动终止上述合作或不配合乙方的工作，乙方可终止对甲方提供的一切服务，并有权利不退还甲方所交服务款。"
          ),

          // ==== 第五条 ====
          heading("第五条：违约"),
          numberedClause(
            1,
            "若任何一方未能履行其在本合同项下之任何义务，或未能遵守其在本合同中所作的任何承诺，或者任何一方在本合同中所做之陈述或保证不真实或重大遗漏，应被视为违约。"
          ),
          numberedClause(
            2,
            "若因任何一方之任何违约行为而使守约方遭受任何直接经济损失，违约方应向守约方赔偿全部该等损失（包括合理的律师费用和开支）"
          ),

          // ==== 第六条 ====
          heading("第六条：其他"),
          numberedClause(
            1,
            "因不可抗力导致甲乙双方或一方不能履行本协议项下有关义务时，甲、乙双方相互不承担违约责任。但遇有不可抗力的一方或双方应于不可抗力发生后10日内将情况告知对方，并提供相关证明。在不可抗力影响消除后的合理时间内，一方或双方应当继续履行协议。"
          ),
          numberedClause(
            2,
            "对于本协议履行而发生的争议，双方协商解决或提交当地人民法院裁决。"
          ),
          numberedClause(
            3,
            "对于本协议未尽事宜，双方可随时签订补充协议或以附件的形式对本协议中的有关问题作出补充、说明、解释。本协议的补充协议和附件为其不可分的部分，与本协议具有同等法律效力。"
          ),
          numberedClause(
            4,
            "本协议一式两份，双方各执一份，甲、乙双方法定代表人或授权代表签字并加盖公章后，方可生效，均具有同等法律效力。"
          ),

          // ---- 分隔 ----
          new Paragraph({
            spacing: { before: 300, after: 200 },
            alignment: AlignmentType.CENTER,
            children: [text("（合同签署，以下无正文）", { color: "666666" })],
          }),

          // ---- 签章区 ----
          signatureTable,
        ],
      },
    ],
  });

  return doc;
}

// ============================================================
// CLI 入口
// ============================================================

async function main() {
  if (process.argv.length < 3) {
    console.error(
      "Usage: node generate_contract.js <input.json> [output_dir]"
    );
    process.exit(1);
  }

  const inputFile = process.argv[2];
  const outputDir = path.resolve(process.argv[3] || defaultOutputDir());

  const data = JSON.parse(fs.readFileSync(inputFile, "utf-8"));
  validateContractData(data);

  fs.mkdirSync(outputDir, { recursive: true });

  // 文件名
  const customerShort = safeFileStem(data.partyA, "customer");
  const baseName = `${customerShort}_合同`;

  const { docxPath, jsonPath } = uniqueOutputPaths(outputDir, baseName);

  // 生成 DOCX
  const doc = generateContract(data);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(docxPath, buffer);
  console.log(`DOCX: ${docxPath}`);

  // 备份 JSON
  const srcJson = path.resolve(inputFile);
  const dstJson = path.resolve(jsonPath);
  if (srcJson !== dstJson) {
    fs.copyFileSync(inputFile, jsonPath);
  }
  console.log(`JSON: ${jsonPath}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
