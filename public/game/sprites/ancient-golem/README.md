# Ancient Golem

Extraídos do vídeo de referência (192 frames, 24fps, câmera fixa), 320x320 RGBA — mesmo
tamanho do troll.

    1.png .. 12.png      parado, flutuando (loop; frames 11-44, emenda casada)
    move-1 .. move-8     deslocando, braços varrendo (frames 48-90)
    atk-1 .. atk-8       placas girando, carga cheia, e voltando (frames 96-116, 178-190)

O disparo em si (frames 136-158 do vídeo) não entrou: o clarão ilumina a sala inteira e o
chão fica tão claro quanto o golem, então não há como separar os dois. Se o feixe for
preciso, ele tem que ser uma camada de efeito à parte, não o sprite.

Recorte: limiar duplo (semente rígida crescida por uma máscara frouxa) para pegar a
placa escura do corpo sem puxar o chão junto; buracos internos preenchidos; cor sangrada
8 passos para fora da borda alfa, senão os pixels transparentes (pretos) viram um contorno
escuro assim que o sprite é reduzido de escala.
