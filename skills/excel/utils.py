"""
Utilidades para Excel - Funciones auxiliares
"""
from typing import List, Tuple, Optional
import colorsys


def format_number(value: float, format_type: str = 'currency') -> str:
    """
    Formatea números según el tipo especificado
    
    Args:
        value: Número a formatear
        format_type: 'currency', 'percentage', 'number', 'accounting'
    
    Returns:
        String formateado
    """
    formats = {
        'currency': '${:,.2f}',
        'percentage': '{:.1%}',
        'number': '{:,.0f}',
        'accounting': '${:,.2f}',
        'decimal': '{:.2f}'
    }
    
    fmt = formats.get(format_type, '{:.2f}')
    return fmt.format(value)


def create_color_palette(base_color: str, n_shades: int = 5) -> List[str]:
    """
    Genera una paleta de colores a partir de un color base
    
    Args:
        base_color: Color en hex (ej: '#4472C4')
        n_shades: Cantidad de tonos a generar
    
    Returns:
        Lista de colores en hex
    """
    # Convertir hex a RGB
    base_color = base_color.lstrip('#')
    r = int(base_color[0:2], 16) / 255
    g = int(base_color[2:4], 16) / 255
    b = int(base_color[4:6], 16) / 255
    
    # Convertir a HLS para manipular luminosidad
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    
    colors = []
    for i in range(n_shades):
        # Variar luminosidad
        new_l = max(0.1, min(0.9, l + (i - n_shades//2) * 0.15))
        nr, ng, nb = colorsys.hls_to_rgb(h, new_l, s)
        # Convertir a hex
        hex_color = '#{:02x}{:02x}{:02x}'.format(
            int(nr * 255), int(ng * 255), int(nb * 255)
        )
        colors.append(hex_color.upper())
    
    return colors


def column_letter_to_index(col: str) -> int:
    """Convierte letra de columna a índice (A=1, B=2, etc.)"""
    result = 0
    for char in col.upper():
        result = result * 26 + (ord(char) - ord('A') + 1)
    return result


def index_to_column_letter(idx: int) -> str:
    """Convierte índice a letra de columna (1=A, 2=B, etc.)"""
    result = ""
    while idx > 0:
        idx, remainder = divmod(idx - 1, 26)
        result = chr(65 + remainder) + result
    return result


def get_range_dimensions(range_str: str) -> Tuple[int, int]:
    """
    Obtiene dimensiones de un rango (filas, columnas)
    
    Ejemplo: 'A1:C10' -> (10, 3)
    """
    # Simplificado - asume formato A1:C10
    parts = range_str.split(':')
    if len(parts) != 2:
        return (0, 0)
    
    start, end = parts
    # Extraer números de fila
    start_row = int(''.join(filter(str.isdigit, start)))
    end_row = int(''.join(filter(str.isdigit, end)))
    # Extraer letras de columna
    start_col = ''.join(filter(str.isalpha, start))
    end_col = ''.join(filter(str.isalpha, end))
    
    rows = end_row - start_row + 1
    cols = column_letter_to_index(end_col) - column_letter_to_index(start_col) + 1
    
    return (rows, cols)


def auto_fit_columns(file_path: str, sheet_name: str = "Sheet1") -> None:
    """Autoajusta el ancho de columnas (requiere xlwings)"""
    import xlwings as xw
    
    app = xw.App(visible=False)
    try:
        wb = app.books.open(file_path)
        sheet = wb.sheets[sheet_name]
        sheet.autofit()
        wb.save()
        wb.close()
    finally:
        app.quit()


# Paletas de colores predefinidas
COLOR_PALETTES = {
    'blue': ['#4472C4', '#5B9BD5', '#A5A5A5', '#264478', '#9E480E'],
    'green': ['#70AD47', '#92D050', '#A5A5A5', '#385723', '#548235'],
    'red': ['#C00000', '#FF0000', '#A5A5A5', '#7F0000', '#FF6565'],
    'purple': ['#7030A0', '#B66DDE', '#A5A5A5', '#4A1C6B', '#9E71C2'],
    'orange': ['#ED7D31', '#FFC000', '#A5A5A5', '#9E480E', '#FF9900'],
    'professional': ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5']
}


def get_palette(name: str) -> List[str]:
    """Obtiene una paleta de colores por nombre"""
    return COLOR_PALETTES.get(name, COLOR_PALETTES['blue'])
