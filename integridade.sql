-- Todos os resultados devem ser zero. Executar em ambiente configurado.
select 'competencias_orfas' verificacao,count(*) falhas from competencies c left join companies p on p.id=c.company_id where p.id is null
union all select 'documentos_orfaos',count(*) from competency_documents d left join competencies c on c.id=d.competency_id where c.id is null
union all select 'versoes_orfas',count(*) from competency_document_versions v left join competency_documents d on d.id=v.competency_document_id where d.id is null
union all select 'campos_orfaos',count(*) from competency_field_values f left join competencies c on c.id=f.competency_id where c.id is null
union all select 'cnpjs_duplicados',count(*) from(select cnpj from companies group by cnpj having count(*)>1) q
union all select 'competencias_duplicadas',count(*) from(select company_id,year,month from competencies group by company_id,year,month having count(*)>1) q
union all select 'campos_duplicados',count(*) from(select competency_id,field_key from competency_field_values group by competency_id,field_key having count(*)>1) q;
