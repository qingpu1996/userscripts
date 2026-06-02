const decimalNumberSource = "(?:\\d+(?:[\\d,]*\\d)?(?:\\.\\d+)?|\\.\\d+)";
const oneWeekSeconds = 7 * 24 * 60 * 60;
const oneWeekLog10 = Math.log10(oneWeekSeconds);

function buildSuffixMap() {
  const units = ["", "U", "D", "T", "Qa", "Qt", "Sx", "Sp", "Oc", "No"];
  const tens = ["", "Dc", "Vg", "Tg", "Qag", "Qtg", "Sxg", "Spg", "Ocg", "Nog"];
  const hundreds = ["", "Ce", "De", "Te", "Qae", "Qte", "Sxe", "Spe", "Oce", "Noe"];
  const secondUnits = ["", "Mi", "Mc", "Na", "Pc", "Fm", "At", "Zp", "Yc", "Xn"];
  const secondTens = ["", "Me", "Du", "Tr", "Te", "Pe", "He", "Hp", "Ot", "En"];
  const secondHundreds = ["", "c", "Ic", "TCn", "TeC", "PCn", "HCn", "HpC", "OCn", "ECn"];
  const secondThousands = ["", "Hc", "DHe", "THt", "TeH", "PHc", "HHe", "HpH", "OHt", "EHc"];

  function part1(value) {
    return units[value % 10]
      + tens[Math.floor(value / 10) % 10]
      + hundreds[Math.floor(value / 100)];
  }

  function part2(value) {
    const ones = value % 10;
    const tensValue = Math.floor(value / 10) % 10;
    const hundredsValue = Math.floor(value / 100) % 10;

    if (value < 10) {
      return secondUnits[value];
    }

    let suffix = "";
    suffix += tensValue === 1 && ones === 0
      ? "Vec"
      : secondTens[ones] + secondHundreds[tensValue];
    suffix += secondThousands[hundredsValue];
    return suffix;
  }

  function makeSuffix(group) {
    if (group < 1) {
      return "";
    }

    if (group < 4) {
      return ["", "K", "M", "B"][group];
    }

    let value = group - 1;
    let level = Math.floor(Math.log(value) / Math.log(1000));
    let suffix = "";

    if (level < 100) {
      level = Math.max(level - 1, 0);
    }

    value = Math.floor(value / (1000 ** level));

    while (value > 0) {
      const next = Math.floor(value / 1000);
      const chunk = Math.floor(value - next * 1000);

      if (chunk > 0) {
        if (chunk === 1 && !level) {
          suffix = "U";
        }

        if (level) {
          suffix = part2(level) + (suffix ? `-${suffix}` : "");
        }

        if (chunk > 1) {
          suffix = part1(chunk) + suffix;
        }
      }

      value = next;
      level += 1;
    }

    return suffix;
  }

  const map = new Map([
    ["", 0],
  ]);

  for (let group = 1; group <= 5000; group += 1) {
    const suffix = makeSuffix(group);
    if (suffix) {
      map.set(suffix, group);
    }
  }

  return map;
}

const suffixes = buildSuffixMap();

function parseDisplayedNumber(value) {
  const text = normalizeText(value)
    .replace(/,/g, "")
    .replace(/^×/, "")
    .replace(/^\+/, "");

  if (!text || text === "0") {
    return { log10: Number.NEGATIVE_INFINITY, zero: true };
  }

  if (text === "∞" || /^inf(?:inity)?$/i.test(text)) {
    return { log10: Number.POSITIVE_INFINITY, zero: false };
  }

  const scientificMatch = text.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))e([+-]?\d+(?:\.\d+)?)$/i);

  if (scientificMatch) {
    const mantissa = Number(scientificMatch[1]);
    const exponent = Number(scientificMatch[2]);

    if (mantissa > 0 && Number.isFinite(exponent)) {
      return {
        log10: Math.log10(mantissa) + exponent,
        zero: false,
      };
    }
  }

  const suffixMatch = text.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:\s*([A-Za-z-]+))?$/);

  if (!suffixMatch) {
    return null;
  }

  const mantissa = Number(suffixMatch[1]);
  const suffix = suffixMatch[2] || "";
  const group = suffixes.get(suffix);

  if (!(mantissa > 0) || group === undefined) {
    return null;
  }

  return {
    log10: Math.log10(mantissa) + group * 3,
    zero: false,
  };
}

function splitLeadingAmount(value) {
  const text = normalizeText(value)
    .replace(/^×/, "")
    .replace(/^\+/, "");

  if (!text) {
    return null;
  }

  const infinityMatch = text.match(/^(∞|inf(?:inity)?)\s*(.*)$/i);

  if (infinityMatch) {
    return {
      amountText: infinityMatch[1],
      amount: parseDisplayedNumber(infinityMatch[1]),
      tail: normalizeText(infinityMatch[2]),
    };
  }

  const scientificMatch = text.match(new RegExp(`^([+\\-]?${decimalNumberSource}[eE][+\\-]?[\\d,.]+)\\s*(.*)$`, "i"));

  if (scientificMatch) {
    return {
      amountText: scientificMatch[1],
      amount: parseDisplayedNumber(scientificMatch[1]),
      tail: normalizeText(scientificMatch[2]),
    };
  }

  const numberMatch = text.match(new RegExp(`^([+\\-]?${decimalNumberSource})\\s*([A-Za-z-]+)?\\s*(.*)$`));

  if (!numberMatch) {
    return null;
  }

  const suffix = numberMatch[2] || "";
  const suffixIsKnown = suffixes.has(suffix);
  const amountText = suffixIsKnown ? `${numberMatch[1]}${suffix}` : numberMatch[1];
  const tail = suffixIsKnown
    ? numberMatch[3]
    : `${suffix} ${numberMatch[3]}`;

  return {
    amountText,
    amount: parseDisplayedNumber(amountText),
    tail: normalizeText(tail),
  };
}

function formatRatio(log10Ratio) {
  if (log10Ratio === Number.POSITIVE_INFINITY) {
    return "∞";
  }

  if (log10Ratio === Number.NEGATIVE_INFINITY) {
    return "0";
  }

  if (!Number.isFinite(log10Ratio)) {
    return "无法计算";
  }

  if (log10Ratio < -3) {
    return "<0.001";
  }

  if (log10Ratio < 6) {
    const ratio = 10 ** log10Ratio;

    if (ratio >= 1000) {
      return ratio.toLocaleString("en-US", { maximumFractionDigits: 0 });
    }

    if (ratio >= 100) {
      return ratio.toFixed(1).replace(/\.0$/, "");
    }

    if (ratio >= 10) {
      return ratio.toFixed(2).replace(/\.?0+$/, "");
    }

    return ratio.toFixed(3).replace(/\.?0+$/, "");
  }

  const exponent = Math.floor(log10Ratio);
  const mantissa = 10 ** (log10Ratio - exponent);
  return `${mantissa.toFixed(2).replace(/\.?0+$/, "")}e${exponent}`;
}

function subtractLog10(minuendLog10, subtrahendLog10) {
  if (subtrahendLog10 === Number.NEGATIVE_INFINITY) {
    return minuendLog10;
  }

  if (minuendLog10 <= subtrahendLog10) {
    return Number.NEGATIVE_INFINITY;
  }

  const gap = subtrahendLog10 - minuendLog10;

  if (gap < -15) {
    return minuendLog10;
  }

  return minuendLog10 + Math.log10(1 - (10 ** gap));
}

function formatDuration(log10Seconds) {
  if (log10Seconds > oneWeekLog10) {
    return "大于一周";
  }

  if (!Number.isFinite(log10Seconds) || log10Seconds < 0) {
    return "不到 1 秒";
  }

  const seconds = 10 ** log10Seconds;
  const roundedSeconds = Math.ceil(seconds);

  if (roundedSeconds < 60) {
    return `${roundedSeconds} 秒`;
  }

  if (roundedSeconds < 3600) {
    const minutes = Math.floor(roundedSeconds / 60);
    const restSeconds = roundedSeconds % 60;
    return restSeconds > 0 ? `${minutes} 分 ${restSeconds} 秒` : `${minutes} 分`;
  }

  if (roundedSeconds < 86400) {
    const hours = Math.floor(roundedSeconds / 3600);
    const minutes = Math.ceil((roundedSeconds % 3600) / 60);
    return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  }

  const days = Math.floor(roundedSeconds / 86400);
  const hours = Math.ceil((roundedSeconds % 86400) / 3600);
  return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
}
