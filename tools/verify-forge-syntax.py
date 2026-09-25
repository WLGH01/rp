# 用 Forge 自己的解析器验证「世界书教给 AI 的语法」真的生效。
#
# 为什么不能靠 info.prompt 判断：Forge 回传的 info.prompt 是**原样回显**输入，
# 括号权重与 BREAK 照样以字面量出现，用它断言会得出错误结论（本脚本第一版就踩了）。
# 真正能证明的是直接调用 Forge 的 parse_prompt_attention：
#   - `(smile:1.3)` 应当被解析成 [('smile', 1.3)]
#   - `BREAK` 应当被解析成 [('BREAK', -1)] 这一段的边界标记
#   - 自然语言句子应当被保留为一段普通文本（权重 1.0）
import sys

sys.path.insert(0, r'D:\Stable-diffusion\sd-webui')
from backend.text_processing.parsing import parse_prompt_attention  # noqa: E402

prompt = (
    'masterpiece, best quality, score_7, safe, 1girl, solo, long hair, purple hair, '
    '(smile:1.3), (long hair:1.2) BREAK She stands beneath the cherry tree with her hands '
    'clasped behind her back.'
)

failures = 0


def check(label, ok, extra=''):
    global failures
    print(f"  {'OK ' if ok else 'FAIL'} {label}{'' if ok else ' - ' + str(extra)}")
    if not ok:
        failures += 1


parts = parse_prompt_attention(prompt, 'Original')
print(f'\n解析出 {len(parts)} 段：')
for text, weight in parts:
    print(f'    weight={weight:<6} {text[:70]!r}')

weights = {text.strip(): weight for text, weight in parts}

print('\n1) 括号权重真的被解析（不是当普通字符塞给编码器）')
check('(smile:1.3) -> smile 权重 1.3', abs(weights.get('smile', 0) - 1.3) < 1e-6, weights.get('smile'))
check('(long hair:1.2) -> long hair 权重 1.2',
      abs(weights.get('long hair', 0) - 1.2) < 1e-6, weights.get('long hair'))
check('括号本身没有留在文本里（字面量 (smile:1.3) 已被吃掉）',
      not any('(smile:1.3)' in t for t, _ in parts))

print('\n2) BREAK 真的被当成分段关键字')
check('解析结果里出现 BREAK 边界标记', any(t == 'BREAK' and w == -1 for t, w in parts))
check('BREAK 没有被当成普通词混进正文', not any('BREAK' in t for t, _ in parts if t != 'BREAK'))

print('\n3) Anima 混合模式第三层（自然语言叙事）被完整保留')
narrative = [t for t, w in parts if 'cherry tree' in t]
check('自然语言句子作为一整段保留', len(narrative) == 1, narrative)
check('自然语言段权重是 1.0（不会被加权弄糊）',
      narrative and abs(dict((t, w) for t, w in parts)[narrative[0]] - 1.0) < 1e-6)

print('\n4) 真实 Danbooru 标签原样保留（硬锚点没被破坏）')
# 注意：parse_prompt_attention 只在**括号/权重**处切分，逗号分隔的普通标签会留在同一段里，
# 所以这里查的是「整段拼接后的文本包含该标签」，而不是「存在一个恰好等于该标签的段」。
all_text = ''.join(t for t, _ in parts)
for tag in ['masterpiece', 'best quality', 'score_7', 'safe', '1girl', 'solo', 'long hair', 'purple hair']:
    check(f'标签 {tag!r} 原样保留', tag in all_text)
check('逗号分隔的普通标签不被切碎（切分只发生在括号/权重处）',
      any(t.startswith('masterpiece, best quality') for t, _ in parts))

print('\n5) 世界书里禁止的 NAI 语法在 SD 解析器下是"无效字符"（所以必须禁）')
nai_parts = parse_prompt_attention('1.3::smile::, source#hug, 2girls | girl, x', 'Original')
nai_text = ''.join(t for t, _ in nai_parts)
check(':: 不会被解析成权重（原样留在文本里，白占额度）', '1.3::smile::' in nai_text, nai_text)
check('| 不会被解析成角色分栏（原样留在文本里）', '|' in nai_text, nai_text)

print(f'\n结果: {"通过" if failures == 0 else "失败"} — {failures} 项失败')
sys.exit(0 if failures == 0 else 1)
