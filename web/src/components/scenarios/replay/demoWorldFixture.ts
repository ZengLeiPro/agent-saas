/**
 * 能力中心回放共用的业务世界底稿。
 *
 * 这里只收口会跨场景重复出现的事实；各场景自己的叙事与展示口径仍留在脚本内。
 */
export const demoWorldFixture = {
  demoDate: {
    iso: "2026-08-09",
    short: "08-09",
    compact: "0809",
  },
  inTransitOrders: {
    count: 17,
    totalAmountCny: 4_027_000,
    totalAmountWan: 402.7,
  },
  deliveryOrder: {
    id: "SO-2026-1027",
    customer: "恒岳重工",
    amountCny: 864_000,
    amountWan: 86.4,
    promisedDeliveryDate: "2026-08-15",
    promisedDeliveryShort: "08-15",
    material: {
      name: "精密轴承",
      model: "6204-RS",
      requiredQuantity: 400,
      shortageQuantity: 400,
      stockQuantity: 0,
      supplierVerbalDeliveryDate: "2026-08-12",
      supplierVerbalDeliveryShort: "08-12",
      assemblyDays: 3,
    },
  },
  meeting: {
    id: "MTG-2026-0809-OPS",
    title: "8 月经营会",
    date: "2026-08-09",
    dateShort: "08-09",
    durationMinutes: 47,
    participantCount: 8,
    confirmedDecisionCount: 5,
    followUpCount: 5,
    ownerCount: 3,
  },
  receivables: {
    count: 12,
    totalAmountCny: 1_682_000,
    totalAmountWan: 168.2,
  },
  haichuanReport: {
    code: "A02",
    name: "样件测试报告",
    promisedDate: "2026-07-25",
    promisedDateShort: "07-25",
    overdueDays: 15,
  },
  openComplaint: {
    id: "NC-2026-0095",
    customer: "海川机械",
    issue: "外包装破损",
    openedDate: "2026-08-07",
    openedDateShort: "08-07",
    suspendedDays: 2,
  },
} as const;
