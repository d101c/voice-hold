#!/usr/bin/env bash
# Turn the frames grabbed by snap@test (fNNNNNN.png, NNNNNN = ms) into a
# constant-25-fps MP4 and a GIF. Usage: make-gif.sh <frames dir> <out basename> [width]
set -euo pipefail
FRAMES="$1"; OUT="$2"; WIDTH="${3:-760}"
FPS=25
SEQ=$(mktemp -d)
mapfile -t files < <(ls "$FRAMES"/f*.png | sort)
last=$(basename "${files[-1]}" .png); last=${last#f}; last=$((10#$last))
n=0; i=0
for ((t = 0; t <= last; t += 1000 / FPS)); do
    while (( i + 1 < ${#files[@]} )); do
        nx=$(basename "${files[i+1]}" .png); nx=${nx#f}
        (( 10#$nx <= t )) || break
        i=$((i + 1))
    done
    ln -s "$(realpath "${files[i]}")" "$SEQ/$(printf '%05d' $n).png"
    n=$((n + 1))
done
ffmpeg -y -loglevel error -framerate $FPS -i "$SEQ/%05d.png" \
    -vf "scale=$WIDTH:-2:flags=lanczos" -c:v libx264 -pix_fmt yuv420p -crf 23 "$OUT.mp4"
ffmpeg -y -loglevel error -i "$OUT.mp4" \
    -vf "fps=$FPS,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" \
    "$OUT.gif"
rm -rf "$SEQ"
ls -la "$OUT.mp4" "$OUT.gif"
