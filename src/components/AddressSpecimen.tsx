/**
 * 地址标本 —— 本设计的签名元素。
 *
 * iCloud 生成的别名是「词 + 分隔符 + 熵」的机器造物：
 * basil-trowel-3h、orchid.chive.5h、77.hazel_muskier、amber-95-adagios。
 * 把 local-part 按分隔符拆开，含数字的段用邮政蓝标出来 ——
 * 这个区分编码的是真实结构（哪一段是苹果加的随机性），不是装饰。
 *
 * 分隔符本身也保留原位并压低对比，因为数据里真的存在三种变体（. _ -），
 * 而「点不能被吞掉」正是这个系统最要命的一条规则。
 */

export interface AddressSpecimenProps {
  email: string;
  /** sm 用于列表，lg 用于详情页的主角位。 */
  size?: 'sm' | 'md' | 'lg';
  showDomain?: boolean;
}

interface Segment {
  text: string;
  kind: 'word' | 'entropy' | 'sep';
}

/** 按分隔符切分；含数字的段视为携带熵。 */
export function splitLocalPart(localPart: string): Segment[] {
  const out: Segment[] = [];
  let buffer = '';

  const flush = (): void => {
    if (!buffer) return;
    out.push({ text: buffer, kind: /\d/.test(buffer) ? 'entropy' : 'word' });
    buffer = '';
  };

  for (const ch of localPart) {
    if (ch === '.' || ch === '_' || ch === '-' || ch === '+') {
      flush();
      out.push({ text: ch, kind: 'sep' });
    } else {
      buffer += ch;
    }
  }
  flush();
  return out;
}

const SIZE_CLASS = {
  sm: 'text-[13px]',
  md: 'text-base',
  lg: 'text-2xl sm:text-3xl',
} as const;

export function AddressSpecimen({ email, size = 'md', showDomain = true }: AddressSpecimenProps) {
  const at = email.lastIndexOf('@');
  const localPart = at > 0 ? email.slice(0, at) : email;
  const domain = at > 0 ? email.slice(at) : '';
  const segments = splitLocalPart(localPart);

  return (
    <span className={`specimen ${SIZE_CLASS[size]}`} title={email}>
      {segments.map((seg, i) => (
        <span
          key={i}
          className={
            seg.kind === 'sep'
              ? 'specimen-sep'
              : seg.kind === 'entropy'
                ? 'specimen-entropy'
                : 'specimen-word'
          }
        >
          {seg.text}
        </span>
      ))}
      {showDomain && domain && <span className="specimen-domain">{domain}</span>}
    </span>
  );
}
