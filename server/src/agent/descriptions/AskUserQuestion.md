暂停 agent loop，向用户提出一个或多个问题（每个问题提供 2-4 个选项）。
每个问题都必须通过 `description` 提供标题下方的自包含背景，写清正在确认的对象、提问原因及选择的必要影响。用户可能完全看不到 TodoWrite、思考过程和工具记录，因此不得把这些过程记录当作提问上下文，也不得使用“以上问题”“前述内容”“如上”等脱离卡片后无法理解的指代。`question` 只写需要用户回答的明确问题；`options[].description` 只解释各选项自身的区别，不能替代问题背景。
multiSelect=true 的问题，该 question key 对应的答案是所选选项 label 组成的数组。
multiSelect=false 时，答案是选中的单个 label 字符串。单选场景直接省略 multiSelect，运行时默认为 false。
