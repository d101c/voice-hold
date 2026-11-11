// The pill is written in the system's interface font (Settings, or Tweaks:
// org.gnome.desktop.interface font-name), at its size: the Shell's own theme
// may use another family. Free of Shell imports, so it runs under plain gjs.
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';

// 'Ubuntu Medium 11' -> "font-family: 'Ubuntu'; font-weight: 500; font-size: 11pt;"
// '' when the description has no usable family.
export function fontCss(description) {
    let desc;
    try {
        desc = Pango.FontDescription.from_string(description || '');
    } catch (_e) {
        return '';
    }
    const family = (desc.get_family() || '').split(',')[0].trim().replace(/['"\;{}]/g, '');
    if (!family)
        return '';
    let css = `font-family: '${family}';`;
    const weight = Number(desc.get_weight());
    if (weight >= 100 && weight <= 900)
        css += ` font-weight: ${Math.round(weight / 100) * 100};`;
    if (desc.get_style() === Pango.Style.ITALIC)
        css += ' font-style: italic;';
    const size = desc.get_size() / Pango.SCALE;
    if (size >= 6 && size <= 48 && !desc.get_size_is_absolute())
        css += ` font-size: ${Math.round(size * 10) / 10}pt;`;
    return css;
}

export function systemFontCss() {
    try {
        return fontCss(new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('font-name'));
    } catch (_e) {
        return '';
    }
}
