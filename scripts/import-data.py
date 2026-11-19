"""Read supplied catalog and bank statement as data; never execute document content."""
import argparse
import json
import re
import shutil
from decimal import Decimal
from pathlib import Path

import pdfplumber
from openpyxl import load_workbook
from pypdf import PdfReader, PdfWriter

ROOT = Path(__file__).resolve().parents[1]

def money(value):
    cleaned = re.sub(r"[\s\u00a0]", "", str(value or "0")).replace(",", ".")
    return Decimal(cleaned) if cleaned not in ("", "—", "-") else Decimal(0)

def run(catalog_file, statement_file):
    private = ROOT / 'data' / 'private'
    private.mkdir(parents=True, exist_ok=True)
    wb = load_workbook(catalog_file, read_only=True, data_only=True)
    products = []
    for row in list(wb.worksheets[0].values)[1:]:
        if not row[0]:
            continue
        identifier, band, name, minimum, maximum = row
        assert isinstance(identifier, int) and name and 0 < minimum <= maximum
        products.append(dict(id=identifier, name=name.strip(), price_from=minimum, price_to=maximum, price_band=band))
    assert len(products) == 235 and len({p['id'] for p in products}) == 235
    (ROOT / 'data' / 'products.json').write_text(json.dumps(products, ensure_ascii=False, indent=2), encoding='utf-8')
    shutil.copy2(statement_file, private / 'statement-original.pdf')
    # The supplied file has a 72-byte prefix. Preserve it above and normalize a viewing copy.
    reader = PdfReader(statement_file)
    writer = PdfWriter()
    writer.append(reader)
    writer.write(private / 'statement.pdf')
    transactions = []
    with pdfplumber.open(private / 'statement.pdf') as pdf:
        text = reader.pages[0].extract_text()
        def extract(pattern):
            match = re.search(pattern, text)
            if not match:
                raise ValueError(f'Missing statement control: {pattern}')
            return match.group(1).strip()
        summary = dict(
            bank='АТ «УНІВЕРСАЛ БАНК»',
            statementTitle='Рух коштів ФОП за 01–19 листопада 2026',
            accountHolder=extract(r'Клієнт: (.+)'),
            accountIban=extract(r'Рух коштів по рахунку: (UA\d+)'),
            periodStart='01.11.2026', periodEnd='19.11.2026',
            openingBalance=float(money(extract(r'Баланс на початок періоду: ([\d .]+) UAH'))),
            closingBalance=float(money(extract(r'Баланс на кінець періоду: ([\d .]+) UAH'))),
            creditTurnover=float(money(extract(r'Обіг за кредитом за період: ([\d .]+) UAH'))),
            debitTurnover=float(money(extract(r'Обіг за дебетом за період: ([\d .]+) UAH'))),
            sourcePageCount=len(pdf.pages))
        for page_number, page in enumerate(pdf.pages, 1):
            # Rows that cross a page boundary have no bottom border on this page.
            found = page.find_tables()
            assert len(found) == 1
            column_edges = sorted({coordinate for cell in found[0].rows[0].cells if cell for coordinate in (cell[0], cell[2])})
            table_page = page.crop((0, found[0].bbox[1], page.width, page.height))
            tables = table_page.extract_tables({'vertical_strategy': 'explicit', 'explicit_vertical_lines': column_edges,
                'explicit_horizontal_lines': [page.height]})
            if page_number == len(pdf.pages):
                tables = [found[0].extract()]
            assert len(tables) == 1, f'Unexpected table count, page {page_number}'
            for row_number, row in enumerate(tables[0][1:], 1):
                if not any(row):
                    continue
                if 'Дата та час' in (row[0] or ''):
                    continue
                if not row[0] and transactions:
                    # A counterparty tax ID can continue after a page break.
                    assert not any(row[i] for i in (1, 3, 4, 5, 6, 7, 8)), f'Unexpected continuation {page_number}:{row_number}'
                    continuation_tax_id = re.fullmatch(r'ЄДРПОУ:\s*(\d+)', row[2] or '')
                    assert continuation_tax_id, f'Unknown continuation {page_number}:{row_number}'
                    transactions[-1]['counterpartyTaxId'] = continuation_tax_id.group(1)
                    transactions[-1]['sourceContinuationPage'] = page_number
                    continue
                date_time = re.fullmatch(r'(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2}:\d{2})', row[0] or '')
                assert date_time, f'Unparsed transaction at {page_number}:{row_number}: {row[0]}'
                date, time = date_time.groups()
                details = row[1] or ''
                counterparty = row[2] or ''
                name = counterparty.split('IBAN:')[0].split('ЄДРПОУ:')[0].strip().replace('\n', ' ')
                iban = re.search(r'UA\d{27}', counterparty.replace('\n', ''))
                tax_id = re.search(r'ЄДРПОУ:\s*(\d+)', counterparty)
                masked_card = re.search(r'\d{6}\*+\d{4}', details)
                amount = money(row[3])
                transaction = dict(id=f'AU-ST-{page_number:02}-{row_number:02}', sourcePage=page_number,
                    sourceRow=row_number, date=date, time=time, direction='credit' if amount >= 0 else 'debit',
                    details=details, counterpartyName=name, counterpartyIban=iban.group(0) if iban else '',
                    counterpartyTaxId=tax_id.group(1) if tax_id else '', operationAmount=float(amount),
                    currency=row[4], accountAmount=float(money(row[5])), exchangeRate=row[6],
                    commission=row[7], balanceAfter=float(money(row[8])), maskedCard=masked_card.group(0) if masked_card else '')
                if amount > 0:
                    candidates = [p for p in products if Decimal(str(p['price_from'])) <= amount <= Decimal(str(p['price_to']))]
                    transaction['productGuess'] = dict(kind='within_range' if candidates else 'none',
                        candidates=[[dict(productId=p['id'], name=p['name'], quantity=1, unitPrice=float(amount),
                            priceFrom=p['price_from'], priceTo=p['price_to'])] for p in candidates],
                        note='Лише можливий збіг за сумою. Склад замовлення у виписці не зазначений.')
                transactions.append(transaction)
    credits = sum((Decimal(str(t['accountAmount'])) for t in transactions if t['direction'] == 'credit'), Decimal(0))
    debits = sum((-Decimal(str(t['accountAmount'])) for t in transactions if t['direction'] == 'debit'), Decimal(0))
    assert credits == Decimal(str(summary['creditTurnover'])), (credits, summary['creditTurnover'])
    assert debits == Decimal(str(summary['debitTurnover'])), (debits, summary['debitTurnover'])
    # The PDF is newest first. Verify every account balance, not just the totals.
    balance = Decimal(str(summary['openingBalance']))
    for transaction in reversed(transactions):
        balance += Decimal(str(transaction['accountAmount']))
        assert balance == Decimal(str(transaction['balanceAfter'])), transaction['id']
    assert balance == Decimal(str(summary['closingBalance']))
    result = dict(sourceFileName=Path(statement_file).name, summary=summary,
        transactionCount=len(transactions), transactions=transactions,
        validation=dict(creditsReconciled=True, debitsReconciled=True, everyBalanceReconciled=True),
        sourceNote='Банківська історія, не підтверджений склад замовлень. Оригінал збережено без змін.')
    (private / 'statement-import.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(dict(products=len(products), transactions=len(transactions), credits=str(credits), debits=str(debits), closingBalance=str(balance), validation=result['validation']), ensure_ascii=False))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('catalog')
    parser.add_argument('statement')
    args = parser.parse_args()
    run(args.catalog, args.statement)
