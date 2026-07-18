暂停 agent loop，向用户提出一个或多个问题（每个问题提供 2-4 个选项）。
multiSelect=true 的问题，该 question key 对应的答案是所选选项 label 组成的数组。
multiSelect=false 时，答案是选中的单个 label 字符串。单选场景直接省略 multiSelect，运行时默认为 false。
