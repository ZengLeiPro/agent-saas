"""
共享盘适配器。

接口契约：
  - async get_express_info(statement_no, customer) -> dict
      返回 {express_no, express_company, recipient, recipient_phone, ship_date}
      从 S:\\贸管部客户对账开票\\...\\{batch}\\客户回复对账结果\\{owner}\\
            打印机器人已完成----打印\\{date}\\打印邮寄客户----{customer}{statement_no}采集
      路径取，路径生成规则待客户补充（见李总清单 #3）
"""

from .mock import create as _mock_create
from .real import create as _real_create
