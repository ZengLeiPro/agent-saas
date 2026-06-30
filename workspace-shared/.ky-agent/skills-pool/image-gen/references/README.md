# 风格提示词参考

来源：[op7418/Document-illustrator-skill](https://github.com/op7418/Document-illustrator-skill)

三套经过验证的 Gemini 图像生成风格 prompt，适用于 Nano Banana Pro (Gemini 3 Pro Image Preview) 和 Seedream 模型。

## 文件说明

| 文件 | 风格 | 适用场景 |
|------|------|---------|
| `gradient-glass.md` | 渐变毛玻璃卡片 | 科技产品、数据分析、趋势展望、Apple Keynote 风 |
| `ticket.md` | 数字极简票券 | 信息图表、数据展示、时间线、黑白高级感 |
| `vector-illustration.md` | 扁平矢量插画 | 故事叙述、概念解释、教育内容、复古温暖 |

## 使用方式

这些文件是独立的 prompt 模板，可以直接拼接到图像生成请求中：

```
{style_prompt}

根据以下内容生成配图：
标题：{title}
内容：{content}
```

在调用 `generate_gemini.py` 时，可以把风格 prompt 作为前缀拼接到用户描述之前。
